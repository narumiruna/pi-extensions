import assert from "node:assert/strict";
import { afterAll, beforeAll, test, vi } from "vitest";
import { S3Client } from "../src/backends/s3/s3-client.js";
import { s3ClientConfig, startS3TestServer, trustS3TestCertificate } from "./s3-http-test-helpers.js";

const snapshot = Buffer.from("private-snapshot-content");
const operations = [
  { method: "GET", run: (client: S3Client) => client.getJson("pi-sync/latest.json") },
  {
    method: "PUT",
    run: (client: S3Client) =>
      client.putBuffer("pi-sync/snapshots/id.json.gz", snapshot, "application/gzip", { ifAbsent: true }),
  },
  { method: "DELETE", run: (client: S3Client) => client.delete("pi-sync/probe") },
];
const destinations = ["relative", "same-origin", "cross-origin", "network-path", "https-to-http"] as const;

let restoreCertificates: (() => void) | undefined;
beforeAll(() => {
  restoreCertificates = trustS3TestCertificate();
});
afterAll(() => restoreCertificates?.());

// Fetch preserves PUT/DELETE on 301/302/307/308, but rewrites them to GET on 303.
// GET stays GET for every redirect status. No class may reach the Location URL.
for (const operation of operations) {
  for (const destination of destinations) {
    test.each([301, 302, 303, 307, 308])(
      `S3 ${operation.method} rejects HTTP %s ${destination} redirects without disclosing credentials or snapshots`,
      async (status) => {
        const sink = await startS3TestServer((_request, response) => {
          response.end('{"unreviewed":true}');
        });
        let location = "";
        const source = await startS3TestServer((request, response) => {
          if (request.path.startsWith("/unreviewed")) {
            response.end('{"unreviewed":true}');
          } else {
            response.writeHead(status, { location });
            response.end();
          }
        }, destination === "https-to-http");
        try {
          location =
            destination === "relative"
              ? "/unreviewed"
              : destination === "same-origin"
                ? `${source.url}/unreviewed`
                : destination === "network-path"
                  ? `${sink.url.replace("http:", "")}/unreviewed`
                  : `${sink.url}/unreviewed`;
          const config = s3ClientConfig(source.url);
          await assert.rejects(operation.run(new S3Client(config)), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /S3 request failed/u);
            assert.doesNotMatch(error.message, /private-access|private-secret|private-session-token/u);
            return true;
          });
          assert.equal(source.requests.length, 1, "only the reviewed object URL receives a request");
          assert.equal(sink.requests.length, 0, "the unreviewed origin receives neither headers nor a body");
          assert.deepEqual(source.errors, []);
          assert.deepEqual(sink.errors, []);
          const request = source.requests[0];
          assert.equal(request?.method, operation.method);
          assert.equal(request?.headers["x-amz-security-token"], config.profile.sessionToken);
          assert.deepEqual(request?.body, operation.method === "PUT" ? snapshot : Buffer.alloc(0));
          if (operation.method === "PUT") {
            assert.equal(request?.headers["if-none-match"], "*");
            assert.match(request?.headers.authorization ?? "", /SignedHeaders=[^ ]*if-none-match/u);
          }
        } finally {
          await Promise.all([source.close(), sink.close()]);
        }
      },
    );
  }
}

for (const operation of operations) {
  test(`R2 ${operation.method} token fallback rejects redirects on its second signed request`, async () => {
    const sink = await startS3TestServer((_request, response) => response.end('{"unreviewed":true}'));
    const source = await startS3TestServer((request, response) => {
      if (request.headers["x-amz-security-token"]) {
        response.writeHead(400);
        response.end("<Error><Code>InvalidArgument</Code><Message>X-Amz-Security-Token</Message></Error>");
      } else {
        response.writeHead(307, { location: `${sink.url}/unreviewed` });
        response.end();
      }
    });
    const networkFetch = globalThis.fetch;
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      // Keep the R2 compatibility decision while routing all transport to loopback.
      const url = new URL(String(input));
      const local = new URL(source.url);
      url.protocol = local.protocol;
      url.host = local.host;
      return networkFetch(url, init);
    });
    try {
      await assert.rejects(
        operation.run(new S3Client(s3ClientConfig("https://account.r2.cloudflarestorage.com"))),
        /S3 request failed/u,
      );
      assert.deepEqual(
        source.requests.map((request) => request.headers["x-amz-security-token"]),
        ["private-session-token", undefined],
      );
      assert.equal(sink.requests.length, 0);
      assert.deepEqual(source.errors, []);
      assert.deepEqual(sink.errors, []);
      for (const request of source.requests) {
        assert.equal(request.method, operation.method);
        assert.deepEqual(request.body, operation.method === "PUT" ? snapshot : Buffer.alloc(0));
        if (operation.method === "PUT") assert.equal(request.headers["if-none-match"], "*");
      }
    } finally {
      await Promise.all([source.close(), sink.close()]);
    }
  });
}

for (const read of [
  { name: "snapshot", run: (client: S3Client) => client.getBuffer("pi-sync/snapshots/id.json.gz") },
  { name: "diagnostic", run: (client: S3Client) => client.diagnoseRead("pi-sync/latest.json") },
]) {
  test(`S3 ${read.name} reads reject a redirect before reading an unbounded response body`, async () => {
    const server = await startS3TestServer((_request, response) => {
      response.writeHead(308, { location: "/unreviewed" });
      response.flushHeaders();
      response.write("unbounded redirect response");
    });
    try {
      await assert.rejects(read.run(new S3Client(s3ClientConfig(server.url))), /S3 request failed/u);
      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });
}
