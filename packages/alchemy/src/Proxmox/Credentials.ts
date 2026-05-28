import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, loadOrConfigure } from "../Auth/Profile.ts";
import {
  PROXMOX_AUTH_PROVIDER_NAME,
  type ProxmoxAuthConfig,
  type ProxmoxResolvedCredentials,
} from "./AuthProvider.ts";

export interface CredentialsValue {
  host: string;
  tokenId: string;
  tokenSecret: Redacted.Redacted<string>;
  ca?: string;
  insecure?: boolean;
}

export class Credentials extends Context.Service<
  Credentials,
  CredentialsValue
>()("Proxmox::Credentials") {}

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        ProxmoxAuthConfig,
        ProxmoxResolvedCredentials
      >(PROXMOX_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const ctx = yield* Effect.context<never>();

      return yield* loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as ProxmoxAuthConfig),
        ),
        Effect.map((creds) => ({
          host: creds.host,
          tokenId: creds.tokenId,
          tokenSecret: creds.tokenSecret,
          ca: creds.ca,
          insecure: creds.insecure,
        })),
        Effect.provide(ctx),
      );
    }),
  );
