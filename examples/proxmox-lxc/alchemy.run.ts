import * as Alchemy from "alchemy";
import * as Linux from "alchemy/Linux";
import * as Postgres from "alchemy/Postgres";
import * as Proxmox from "alchemy/Proxmox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// LXC template to provision from. Override with PROXMOX_TEMPLATE if your
// cluster ships a different Debian image (list with `pveam available` on a
// node, or the proxmox-lxc skill's list-templates.sh).
const TEMPLATE =
  process.env.PROXMOX_TEMPLATE ??
  "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst";

const providers = () =>
  Layer.mergeAll(Proxmox.providers(), Linux.providers(), Postgres.providers());

// `Proxmox.Postgres` composes the whole stack: an LXC container, the apt
// install, a provisioning step (superuser password + listen_addresses +
// pg_hba), and a Postgres role + database reachable over TCP.
export default Alchemy.Stack(
  "ProxmoxPostgresExample",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* Proxmox.Postgres("db", {
      template: TEMPLATE,
      hostname: "alchemy-postgres",
      node: process.env.PROXMOX_NODE,
      cores: 1,
      memory: 512,
      disk: 8,
      role: process.env.PG_APP_ROLE,
      database: process.env.PG_APP_DB,
      password: process.env.PG_APP_PASSWORD
        ? Redacted.make(process.env.PG_APP_PASSWORD)
        : undefined,
      ssh: {
        // Set PROXMOX_SSH_HOST only when the Proxmox node name is not
        // resolvable from this machine; otherwise the construct uses
        // container.node for `pct exec`.
        host: process.env.PROXMOX_SSH_HOST,
        identity: process.env.PROXMOX_SSH_IDENTITY,
      },
    });

    return {
      ipv4: db.ipv4,
      role: db.role,
      database: db.database,
      // Redacted — the engine prints "<redacted>", never the secret.
      connectionUrl: db.connectionUrl,
    };
  }),
);
