import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { Profile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";

export const PROXMOX_AUTH_PROVIDER_NAME = "Proxmox";

export type ProxmoxAuthConfig = { method: "env" } | { method: "stored" };

export type ProxmoxStoredCredentials = {
  type: "apiToken";
  host: string;
  tokenId: string;
  tokenSecret: string;
  ca?: string;
  insecure?: boolean;
};

export type ProxmoxResolvedCredentials = {
  type: "apiToken";
  host: string;
  tokenId: string;
  tokenSecret: Redacted.Redacted<string>;
  ca?: string;
  insecure?: boolean;
  source: { type: ProxmoxAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: ProxmoxAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: "PROXMOX_HOST, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET",
  },
  {
    value: "stored",
    label: "API Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Layer that registers the Proxmox {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 *
 * The implementation is an `Effect` that resolves the {@link Profile} and
 * {@link CredentialsStore} services once at layer-build time and closes over
 * them — mirroring Neon's `NeonAuth`. The `AuthProvider` factory captures the
 * surrounding context and re-provides it to every callback, so the registered
 * provider's methods carry `R = never`.
 */
export const ProxmoxAuth = AuthProviderLayer<
  ProxmoxAuthConfig,
  ProxmoxResolvedCredentials
>()(
  PROXMOX_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* Profile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
      const host = yield* Clank.text({
        message: "Proxmox host (e.g. 192.0.2.10)",
        validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const tokenId = yield* Clank.text({
        message: "API token id (e.g. root@pam!alchemy)",
        validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const tokenSecret = yield* Clank.password({
        message: "API token secret",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const skipTls = yield* Clank.confirm({
        message: "Skip TLS verification? (home cluster: yes)",
        initialValue: true,
      }).pipe(retryOnce);

      let ca: string | undefined;
      if (!skipTls) {
        const caInput = yield* Clank.text({
          message:
            "PEM-encoded CA cert (paste contents or leave empty to skip)",
        }).pipe(retryOnce);
        ca = caInput.trim().length > 0 ? caInput.trim() : undefined;
      }

      yield* store.write<ProxmoxStoredCredentials>(
        profileName,
        "proxmox-stored",
        {
          type: "apiToken",
          host: host.trim(),
          tokenId: tokenId.trim(),
          tokenSecret,
          ca,
          insecure: skipTls ? true : undefined,
        },
      );
      yield* Clank.success("Proxmox: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Proxmox authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (
      profileName: string,
      ctx: ConfigureContext,
    ) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }
        return yield* configureInteractive(profileName);
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: ProxmoxAuthConfig,
    ): Effect.Effect<ProxmoxResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fnUntraced(function* () {
            const host = yield* getEnv("PROXMOX_HOST");
            if (!host) {
              return yield* new AuthError({
                message:
                  "Proxmox env credentials not found. Set PROXMOX_HOST, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET.",
              });
            }
            const tokenId = yield* getEnv("PROXMOX_TOKEN_ID");
            if (!tokenId) {
              return yield* new AuthError({
                message: "Missing required env: PROXMOX_TOKEN_ID",
              });
            }
            const tokenSecret = yield* getEnvRedacted("PROXMOX_TOKEN_SECRET");
            if (!tokenSecret) {
              return yield* new AuthError({
                message: "Missing required env: PROXMOX_TOKEN_SECRET",
              });
            }
            const ca = yield* getEnv("PROXMOX_CA");
            const insecureStr = yield* getEnv("PROXMOX_INSECURE");
            const insecure =
              insecureStr === "1" || insecureStr === "true" ? true : undefined;
            return {
              type: "apiToken" as const,
              host,
              tokenId,
              tokenSecret,
              ca: ca ?? undefined,
              insecure,
              source: { type: "env" as const },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read<ProxmoxStoredCredentials>(profileName, "proxmox-stored")
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "Proxmox stored credentials not found. Run: alchemy-effect login --configure",
                      }),
                    )
                  : Effect.succeed({
                      type: "apiToken" as const,
                      host: creds.host,
                      tokenId: creds.tokenId,
                      tokenSecret: Redacted.make(creds.tokenSecret),
                      ca: creds.ca,
                      insecure: creds.insecure,
                      source: { type: "stored" as const },
                    }),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: ProxmoxAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "proxmox-stored")
            .pipe(
              Effect.andThen(
                Clank.success("Proxmox: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: ProxmoxAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            getEnv("PROXMOX_HOST").pipe(
              Effect.flatMap((host) =>
                host
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [PROXMOX_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<ProxmoxStoredCredentials>(profileName, "proxmox-stored")
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const prettyPrint = (profileName: string, config: ProxmoxAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  host:        ${creds.host}`),
            Console.log(`  tokenId:     ${creds.tokenId}`),
            Console.log(
              `  tokenSecret: ${displayRedacted(creds.tokenSecret, 6)}`,
            ),
            Console.log(`  ca:          ${creds.ca ? "(present)" : "(none)"}`),
            Console.log(`  insecure:    ${creds.insecure ?? false}`),
            Console.log(`  source:      ${sourceStr}`),
          ]);
        }),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
      );

    return {
      configure: configureCredentials,
      logout,
      login,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);
