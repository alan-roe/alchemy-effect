import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  PROXMOX_AUTH_PROVIDER_NAME,
  type ProxmoxAuthConfig,
  type ProxmoxResolvedCredentials,
} from "./AuthProvider.ts";

export interface ProxmoxEnvironmentValue {
  /** PVE host or IP (no protocol, no port). API uses :8006. */
  host: string;
  /** API token id e.g. "root@pam!alchemy" */
  tokenId: string;
  /** Secret half of the API token */
  tokenSecret: Redacted.Redacted<string>;
  /** PEM-encoded CA cert for TLS verification (production). */
  ca?: string;
  /** Skip TLS verification (home-cluster default). */
  insecure?: boolean;
}

/**
 * The resolved Proxmox connection record: combined network + auth, mirroring
 * Neon's `NeonEnvironment` (1:1, unlike AWS's Region + Credentials split). This
 * is the single service every Proxmox API call, client, and resource provider
 * requires.
 */
export class ProxmoxEnvironment extends Context.Service<
  ProxmoxEnvironment,
  ProxmoxEnvironmentValue
>()("Proxmox::ProxmoxEnvironment") {}

/**
 * Build the `ProxmoxEnvironment` layer directly from the registered Proxmox
 * `AuthProvider`. Mirrors Neon's `NeonEnvironment.fromProfile` — wire this into
 * `providers()` alongside `ProxmoxAuth`.
 */
export const fromProfile = () =>
  Layer.effect(
    ProxmoxEnvironment,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        ProxmoxAuthConfig,
        ProxmoxResolvedCredentials
      >(PROXMOX_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      const config = yield* profile.loadOrConfigure(auth, profileName, { ci });
      const creds = yield* auth.read(profileName, config as ProxmoxAuthConfig);
      return {
        host: creds.host,
        tokenId: creds.tokenId,
        tokenSecret: creds.tokenSecret,
        ca: creds.ca,
        insecure: creds.insecure,
      };
    }),
  );
