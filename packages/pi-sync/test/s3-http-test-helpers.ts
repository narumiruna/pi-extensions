import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { ResolvedS3Backend } from "../src/backends/backend-types.js";

export interface S3TestRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export function s3ClientConfig(endpoint = "https://s3.example.com"): ResolvedS3Backend {
  return {
    type: "s3",
    profile: {
      kind: "s3-compatible",
      endpoint,
      region: "us-east-1",
      accessKeyId: "private-access",
      secretAccessKey: "private-secret",
      sessionToken: "private-session-token",
    },
    destination: { bucket: "bucket", prefix: "pi-sync", namespace: "default" },
  };
}

export async function startS3TestServer(
  handle: (request: S3TestRequest, response: ServerResponse) => void,
  https = false,
) {
  const requests: S3TestRequest[] = [];
  const errors: unknown[] = [];
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void record(request)
      .then((recorded) => {
        requests.push(recorded);
        handle(recorded, response);
      })
      .catch((error: unknown) => {
        errors.push(error);
        response.destroy();
      });
  };
  const server = https
    ? createHttpsServer({ key: TEST_KEY, cert: TEST_CERTIFICATE }, listener)
    : createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local S3 test server did not bind.");
  return {
    url: `${https ? "https" : "http"}://127.0.0.1:${address.port}`,
    requests,
    errors,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export function trustS3TestCertificate() {
  const original = getCACertificates("default");
  setDefaultCACertificates([...original, TEST_CERTIFICATE]);
  return () => setDefaultCACertificates(original);
}

async function record(request: IncomingMessage): Promise<S3TestRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: request.headers,
    body: Buffer.concat(chunks),
  };
}

// Test-only loopback identity. Trust this certificate explicitly instead of disabling TLS verification.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRyccyu8Wszg3zkOD
HUoKyMkEAJtY7mtQzoF0EK+ePsqhRANCAAT6DddkMo1GCjUDEjuHVBIyqGw9LJ1r
dDpAxTkdAEEhH8miGen/P0roYqYhoqYpuJKN5poIAae2j5KbTSzkHEbF
-----END PRIVATE KEY-----`;

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBkzCCATigAwIBAgIUVws2+sr6SnjABkl/HA7q1ZmoCdkwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVUGkgU3luYyBsb2NhbCBTMyB0ZXN0MCAXDTI2MTEwNjE5NTkx
N1oYDzIxMjYxMDEzMTk1OTE3WjAgMR4wHAYDVQQDDBVQaSBTeW5jIGxvY2FsIFMz
IHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT6DddkMo1GCjUDEjuHVBIy
qGw9LJ1rdDpAxTkdAEEhH8miGen/P0roYqYhoqYpuJKN5poIAae2j5KbTSzkHEbF
o04wTDAdBgNVHQ4EFgQUem0L3fXGxPlOHbEmUeR4DvztG/0wDwYDVR0TAQH/BAUw
AwEB/zAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZIzj0EAwIDSQAw
RgIhAJ/vhdGmSVub81xDZeIrHjZqUEm+DOpYsw5/JfNuhjnIAiEAlmcuqCiqSj3l
eiG2bENl6C/YoFSynm2GL6twftAHRxc=
-----END CERTIFICATE-----`;
