import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as https from "node:https";
import { ProxmoxEnvironment } from "./Environment.ts";

export class ProxmoxApiError extends Data.TaggedError("ProxmoxApiError")<{
  status: number;
  method: string;
  path: string;
  body?: unknown;
  message: string;
}> {}

/**
 * Make a JSON request against the PVE REST API.
 *
 * Returns the `data` field of the response envelope `{data: ...}`.
 * Non-2xx responses become `ProxmoxApiError`.
 *
 * `path` should be relative, e.g. `"/cluster/nextid"`. The base URL
 * `https://{host}:8006/api2/json` is derived from `ProxmoxEnvironment`.
 *
 * For GET and DELETE, `params` are serialized as a query string (PVE rejects
 * request bodies on DELETE with HTTP 501 "Unexpected content for method").
 * For POST/PUT, `params` are sent as `application/x-www-form-urlencoded`.
 * Booleans are serialized as `"0"` / `"1"` (PVE convention). `undefined`
 * values are omitted.
 */
export const request = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Effect.Effect<unknown, ProxmoxApiError, ProxmoxEnvironment> =>
  Effect.gen(function* () {
    const creds = yield* ProxmoxEnvironment;
    const baseUrl = `https://${creds.host}:8006/api2/json`;
    const authHeader = `PVEAPIToken=${creds.tokenId}=${Redacted.value(creds.tokenSecret)}`;

    // Filter out undefined values and serialize params
    const filteredParams: Record<string, string> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        if (typeof v === "boolean") {
          filteredParams[k] = v ? "1" : "0";
        } else {
          filteredParams[k] = String(v);
        }
      }
    }

    let urlPath = `/api2/json${path}`;
    let body: string | undefined;
    const headers: Record<string, string | number> = {
      Authorization: authHeader,
      Accept: "application/json",
    };

    if (
      (method === "GET" || method === "DELETE") &&
      Object.keys(filteredParams).length > 0
    ) {
      const qs = new URLSearchParams(filteredParams).toString();
      urlPath = `${urlPath}?${qs}`;
    } else if (
      (method === "POST" || method === "PUT") &&
      Object.keys(filteredParams).length > 0
    ) {
      body = new URLSearchParams(filteredParams).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const agentOptions: https.AgentOptions = {};
    if (creds.ca) {
      agentOptions.ca = creds.ca;
    } else if (creds.insecure) {
      agentOptions.rejectUnauthorized = false;
    }

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<unknown>((resolve, reject) => {
          const req = https.request(
            {
              hostname: creds.host,
              port: 8006,
              path: urlPath,
              method,
              headers,
              agent: new https.Agent(agentOptions),
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer | string) => {
                chunks.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
              });
              res.on("end", () => {
                const responseText = Buffer.concat(chunks).toString("utf8");
                const statusCode = res.statusCode ?? 500;

                let parsed: unknown;
                try {
                  parsed = responseText.length > 0
                    ? JSON.parse(responseText)
                    : undefined;
                } catch {
                  parsed = responseText;
                }

                if (statusCode >= 400) {
                  const message =
                    typeof parsed === "object" &&
                    parsed != null &&
                    (parsed as { errors?: { message?: string }; message?: string }).message
                      ? (parsed as { message: string }).message
                      : `HTTP ${statusCode}`;
                  reject(
                    new ProxmoxApiError({
                      status: statusCode,
                      method,
                      path,
                      body: parsed,
                      message,
                    }),
                  );
                  return;
                }

                // PVE wraps responses as { data: ... }
                const data =
                  typeof parsed === "object" &&
                  parsed != null &&
                  "data" in (parsed as object)
                    ? (parsed as { data: unknown }).data
                    : parsed;

                resolve(data);
              });
            },
          );

          req.on("error", (err) => {
            reject(
              new ProxmoxApiError({
                status: 0,
                method,
                path,
                message: `Network error: ${err.message}`,
              }),
            );
          });

          if (body !== undefined) {
            req.write(body);
          }
          req.end();
        }),
      catch: (err) =>
        err instanceof ProxmoxApiError
          ? err
          : new ProxmoxApiError({
              status: 0,
              method,
              path,
              message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            }),
    });
  });
