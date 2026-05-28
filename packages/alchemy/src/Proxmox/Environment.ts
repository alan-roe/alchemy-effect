import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials } from "./Credentials.ts";

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

export class ProxmoxEnvironment extends Context.Service<
  ProxmoxEnvironment,
  ProxmoxEnvironmentValue
>()("Proxmox::ProxmoxEnvironment") {}

/**
 * Build a `ProxmoxEnvironment` layer from the resolved `Credentials` service.
 * Equivalent to Neon's `fromProfile` — wire this into `providers()` alongside
 * `Credentials.fromAuthProvider()`.
 */
export const fromProfile = () =>
  Layer.effect(
    ProxmoxEnvironment,
    Effect.gen(function* () {
      const creds = yield* Credentials;
      return {
        host: creds.host,
        tokenId: creds.tokenId,
        tokenSecret: creds.tokenSecret,
        ca: creds.ca,
        insecure: creds.insecure,
      };
    }),
  );
