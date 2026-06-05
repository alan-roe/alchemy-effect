import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as crypto from "node:crypto";
import { Action } from "../Action.ts";
import * as Construct from "../Construct.ts";
import { Package } from "../Linux/Package.ts";
import { execOrFail, quoteArg, type RemoteHost } from "../Linux/Remote.ts";
import {
  DEFAULT_PORT,
  type PostgresConnection,
} from "../Postgres/Connection.ts";
import { PostgresDatabase } from "../Postgres/Database.ts";
import { PostgresRole } from "../Postgres/Role.ts";
import { quoteLiteral } from "../Postgres/sql.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { Container } from "./LXC/Container.ts";

/**
 * Properties for a self-hosted PostgreSQL server on a Proxmox LXC container.
 */
export interface PostgresProps {
  /** LXC template to provision the container from. */
  template: string;
  /** Container hostname. Defaults to a generated name. */
  hostname?: string;
  /** Cluster node to place the container on. */
  node?: string;
  /** CPU cores for the container. */
  cores?: number;
  /** Memory (MB) for the container. */
  memory?: number;
  /** Root disk size (GB) for the container. */
  disk?: number;
  /**
   * apt package to install.
   * @default "postgresql"
   */
  package?: string;
  /** App role name. Defaults to a generated name. */
  role?: string;
  /** App database name. Defaults to a generated name. */
  database?: string;
  /** App role password. Defaults to a generated 24-byte secret. */
  password?: Redacted.Redacted<string>;
  /**
   * Superuser (`postgres`) password set during provisioning. Defaults to a
   * fresh random secret on every deploy — pass an explicit value to keep it
   * stable across deploys.
   */
  adminPassword?: Redacted.Redacted<string>;
  /**
   * CIDR allowed to connect with password (scram) auth, written to `pg_hba`.
   * @default "0.0.0.0/0"
   */
  allowCidr?: string;
  /**
   * How to SSH to the Proxmox node for `pct exec`. By default the container's
   * node name is the SSH host (relies on it resolving via DNS / `~/.ssh/config`);
   * set `host` to the node's IP when it does not resolve.
   */
  ssh?: {
    /** SSH host/IP of the node. Defaults to the container's node name. */
    host?: string;
    /**
     * SSH user on the node.
     * @default "root"
     */
    user?: string;
    /**
     * SSH port on the node.
     * @default 22
     */
    port?: number;
    /** Path to an SSH private key. Defaults to ssh's own resolution. */
    identity?: string;
  };
}
/**
 * Configure a freshly-installed PostgreSQL on a container and hand back the
 * admin connection. This is an `Action`, not a resource: it is an imperative,
 * version-agnostic bootstrap (set the superuser password, open
 * `listen_addresses`, append a `pg_hba` rule, restart) with no meaningful
 * `read`. It runs over the local `pct exec` transport so the password rides
 * stdin into `psql` and never appears in argv/`ps`. The returned connection is
 * consumed by the `Postgres.Role`/`Database` resources, which establishes the
 * deploy-order edge "provision the server before creating roles over TCP".
 */
interface ProvisionInput {
  host: RemoteHost;
  ipv4: string | undefined;
  version: string | undefined;
  adminPassword: Redacted.Redacted<string>;
  allowCidr: string;
}

const Provision = Action(
  "Proxmox.Postgres.Provision",
  Effect.fn(function* (input: ProvisionInput) {
    if (input.ipv4 === undefined) {
      return yield* Effect.fail(
        new Error(
          "Proxmox.Postgres: container reported no IPv4 address; cannot provision over TCP",
        ),
      );
    }
    yield* Effect.logInfo(
      `Provisioning PostgreSQL ${input.version ?? "(unknown)"} on ${input.host.node}/${input.host.vmid}`,
    );

    // 1. Superuser password + server settings via local peer auth. The SQL
    //    (with the password literal) rides stdin into psql, never argv.
    const sql = `${[
      "ALTER SYSTEM SET listen_addresses = '*';",
      "ALTER SYSTEM SET password_encryption = 'scram-sha-256';",
      `ALTER USER postgres PASSWORD ${quoteLiteral(Redacted.value(input.adminPassword))};`,
    ].join("\n")}\n`;
    yield* execOrFail(
      input.host,
      "LC_ALL=C runuser -u postgres -- psql -v ON_ERROR_STOP=1 -X -q",
      { stdin: sql },
    );

    // 2. Append a password (scram) rule for the allowed CIDR, idempotently,
    //    to the cluster's actual pg_hba.conf (discovered via SHOW hba_file).
    const hbaLine = `host all all ${input.allowCidr} scram-sha-256`;
    yield* execOrFail(
      input.host,
      `HBA=$(LC_ALL=C runuser -u postgres -- psql -tAc 'SHOW hba_file'); grep -qF ${quoteArg(hbaLine)} "$HBA" || printf '%s\\n' ${quoteArg(hbaLine)} >> "$HBA"`,
    );

    // 3. Restart so listen_addresses takes effect, then wait for readiness.
    yield* execOrFail(input.host, "systemctl restart postgresql");
    yield* execOrFail(
      input.host,
      "for i in $(seq 1 60); do LC_ALL=C runuser -u postgres -- pg_isready -q && exit 0; sleep 1; done; exit 1",
    );

    return {
      host: input.ipv4,
      port: DEFAULT_PORT,
      database: "postgres",
      user: "postgres",
      password: input.adminPassword,
      ssl: false,
    } satisfies PostgresConnection;
  }),
);

/**
 * A self-hosted PostgreSQL server on a Proxmox LXC container, assembled from
 * first-class primitives: a `Proxmox.LXC.Container`, a `Linux.Package` install,
 * a provisioning `Action`, and `Postgres.Role` + `Postgres.Database` over TCP.
 *
 * Merge the three provider layers into the stack:
 * `Layer.mergeAll(Proxmox.providers(), Linux.providers(), Postgres.providers())`.
 *
 * @section Creating a Server
 * @example A database with an app role
 * ```typescript
 * const db = yield* Proxmox.Postgres("app", {
 *   template: "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
 * });
 * // db.connectionUrl (Redacted), db.origin, db.password (Redacted), db.ipv4
 * ```
 */
export const Postgres = Construct.fn(function* (
  id: string,
  props: PostgresProps,
) {
  const container = yield* Container("Container", {
    template: props.template,
    hostname: props.hostname,
    node: props.node,
    cores: props.cores,
    memory: props.memory,
    disk: props.disk,
    start: true,
  });

  const host = {
    node: props.ssh?.host ?? container.node,
    vmid: container.vmid,
    user: props.ssh?.user,
    port: props.ssh?.port,
    identity: props.ssh?.identity,
  };

  const server = yield* Package("Server", {
    host,
    name: props.package ?? "postgresql",
  });

  const adminPassword =
    props.adminPassword ??
    (yield* Effect.sync(() =>
      Redacted.make(crypto.randomBytes(24).toString("base64url")),
    ));

  // Depends on `server` (via version) and `container` (host + ipv4); produces
  // the admin connection the Postgres resources connect through.
  const connection = yield* Provision({
    host,
    ipv4: container.ipv4,
    version: server.version,
    adminPassword,
    allowCidr: props.allowCidr ?? "0.0.0.0/0",
  }).pipe(Effect.provide(PlatformServices));

  const role = yield* PostgresRole("Role", {
    connection,
    name: props.role,
    password: props.password,
  });

  const database = yield* PostgresDatabase("Database", {
    connection,
    name: props.database,
    owner: role.name,
  });

  return {
    /** Container IPv4 address. */
    ipv4: container.ipv4,
    /** App role name. */
    role: role.name,
    /** App database name. */
    database: database.name,
    /** Structured origin for the app role (feeds Hyperdrive & friends). */
    origin: role.origin,
    /** Direct connection URL for the app role (Redacted). */
    connectionUrl: role.connectionUrl,
    /** App role password (Redacted). */
    password: role.password,
  };
});
