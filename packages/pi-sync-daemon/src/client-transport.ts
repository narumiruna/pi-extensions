import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { lt, valid } from "semver";
import { DAEMON_BUILD_VERSION } from "./build-version.js";
import { daemonPaths, type RuntimePaths, readJsonBody } from "./identity.js";
import { type Identity, MAX_MESSAGE_BYTES, type RemoteError, record } from "./protocol.js";

export class DaemonError extends Error {
  readonly remote: RemoteError;
  constructor(remote: RemoteError) {
    super(remote.message);
    this.name = remote.name;
    this.remote = remote;
  }
}
export async function requestDaemon(
  paths: RuntimePaths,
  identity: Identity,
  method: string,
  params: unknown,
  signal?: AbortSignal,
  options?: { onSocket?(socket: Socket): void; reviewDetails?: 1 },
): Promise<unknown> {
  signal?.throwIfAborted();
  const body = JSON.stringify({
    version: 1,
    root: paths.root,
    instance: identity.instance,
    token: identity.token,
    method,
    params,
    ...(method === "attach" && options?.reviewDetails === 1 ? { reviewDetails: 1 } : {}),
  });
  if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new Error("Daemon request exceeds its byte limit.");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: daemonPaths(paths, identity.instance).endpoint,
        path: "/v1",
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        void readJsonBody(response)
          .then((value) => {
            if (!record(value)) throw new Error("Invalid daemon response.");
            if (record(value.error) && typeof value.error.message === "string")
              throw new DaemonError(value.error as unknown as RemoteError);
            if (response.statusCode !== 200 || !Object.hasOwn(value, "result"))
              throw new Error("Invalid daemon response.");
            resolve(value.result);
          })
          .catch(reject);
      },
    );

    request.setTimeout(method === "attach" || method === "resume-contact" ? 0 : 30_000, () =>
      request.destroy(new Error("Daemon request timed out.")),
    );
    request.once("error", reject);
    if (options?.onSocket) request.once("socket", options.onSocket);
    request.end(body);
  });
}
export async function hello(paths: RuntimePaths, identity: Identity, signal?: AbortSignal) {
  const value = await requestDaemon(paths, identity, "hello", {}, signal);
  if (
    !record(value) ||
    value.version !== 1 ||
    value.root !== paths.root ||
    value.instance !== identity.instance ||
    value.pid !== identity.pid
  )
    throw new Error("Daemon handshake mismatch.");
  const version = value.buildVersion;
  if (Object.hasOwn(value, "buildVersion") && (typeof version !== "string" || valid(version) !== version))
    throw new Error("Invalid daemon build version.");

  return { needsUpgrade: typeof version !== "string" || lt(version, DAEMON_BUILD_VERSION) };
}
