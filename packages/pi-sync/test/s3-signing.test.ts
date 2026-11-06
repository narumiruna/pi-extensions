import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { S3Client } from "../src/backends/s3/s3-client.js";
import { encodeKey } from "../src/paths.js";
import { normalizeS3Bucket, normalizeS3Endpoint, normalizeStoragePath } from "../src/settings/settings-validation.js";
import { s3ClientConfig, startS3TestServer } from "./s3-http-test-helpers.js";

const keyCases = [
  { key: "AZaz09-._~/latest.json", encoded: "AZaz09-._~/latest.json" },
  { key: "work!'()*/latest.json", encoded: "work%21%27%28%29%2A/latest.json" },
  {
    key: "has space+plus/#?%&=:@$;,[]/café/東京/📦.json",
    encoded:
      "has%20space%2Bplus/%23%3F%25%26%3D%3A%40%24%3B%2C%5B%5D/caf%C3%A9/" + "%E6%9D%B1%E4%BA%AC/%F0%9F%93%A6.json",
  },
  {
    key: "literal%2F/%2e%2e/%FF/has%20space.json",
    encoded: "literal%252F/%252e%252e/%25FF/has%2520space.json",
  },
  { key: "cafe\u0301/café/latest.json", encoded: "cafe%CC%81/caf%C3%A9/latest.json" },
];

test.each(keyCases)("S3 encodes an accepted storage path $key without changing key identity", ({ key, encoded }) => {
  assert.equal(normalizeStoragePath(key), key);
  assert.equal(encodeKey(key), encoded);
});

test("S3 key encoding covers every ASCII character and C1 control", () => {
  for (let code = 0; code <= 0x9f; code += 1) {
    const character = String.fromCharCode(code);
    const hex = code.toString(16).toUpperCase().padStart(2, "0");
    const expected = /^[A-Za-z0-9._~/-]$/u.test(character) ? character : code < 0x80 ? `%${hex}` : `%C2%${hex}`;
    assert.equal(encodeKey(`before${character}after`), `before${expected}after`, `U+${hex}`);
  }
});

test("S3 storage path validation still rejects every C0 and C1 control", () => {
  for (let code = 0; code <= 0x9f; code += 1) {
    if (code >= 0x20 && code < 0x7f) continue;
    assert.throws(() => normalizeStoragePath(`safe/${String.fromCharCode(code)}/path`), /safe relative path/u);
  }
});

test.each(["\ud800", "\udfff"])("S3 rejects malformed UTF-16 key %j before transport", async (key) => {
  using fetch = vi.spyOn(globalThis, "fetch");
  assert.throws(() => encodeKey(key), URIError);
  await assert.rejects(new S3Client(s3ClientConfig()).getJson(`safe/${key}/latest.json`), URIError);
  assert.equal(fetch.mock.calls.length, 0);
});

// Fixed SigV4 vectors use the literal canonical URI, an empty query, the fixed
// timestamp below, and private-secret as the secret access key. Expected signatures
// do not use the encoder, signer, or undeclared AWS packages at test time.
const signingCases = [
  {
    name: "unreserved GET",
    method: "GET",
    key: "AZaz09-._~/latest.json",
    path: "/bucket/AZaz09-._~/latest.json",
    signature: "7e97c458826f1d3369c50f03b58911701c2eb13f447185123ddea83d99061bca",
  },
  {
    name: "RFC3986 punctuation GET",
    method: "GET",
    key: "work!'()*/latest.json",
    path: "/bucket/work%21%27%28%29%2A/latest.json",
    signature: "172dbc2c7171516a63070d1901fedb798b94c112d446adf1bda19b75c5daf410",
  },
  {
    name: "reserved and Unicode GET",
    method: "GET",
    key: "has space+plus/#?%&=:@$;,[]/café/東京/📦.json",
    path:
      "/bucket/has%20space%2Bplus/%23%3F%25%26%3D%3A%40%24%3B%2C%5B%5D/caf%C3%A9/" +
      "%E6%9D%B1%E4%BA%AC/%F0%9F%93%A6.json",
    signature: "bdfbf9448f5e8a89ccbc38956edefe1433147f1af745e9a5a9b014649931c441",
  },
  {
    name: "escaped-looking key GET",
    method: "GET",
    key: "literal%2F/%2e%2e/%FF/has%20space.json",
    path: "/bucket/literal%252F/%252e%252e/%25FF/has%2520space.json",
    signature: "1a9383365ce057f2ecad7fd076214dfdff098ba4e6ede55fba7534e288155e7d",
  },
  {
    name: "controls GET",
    method: "GET",
    key: "controls/\u0000\u0009\u000a\u000d\u001b\u001f\u007f\u0080\u009f.json",
    path: "/bucket/controls/%00%09%0A%0D%1B%1F%7F%C2%80%C2%9F.json",
    signature: "d9970acb181ab602bc508918808f722c18b07b5383df43e8e36b963bf82fb55f",
  },
  {
    name: "literal bucket GET",
    method: "GET",
    bucket: "bucket!'()* ?#%+&=:@$;,[] café",
    key: "latest.json",
    path: "/bucket%21%27%28%29%2A%20%3F%23%25%2B%26%3D%3A%40%24%3B%2C%5B%5D%20caf%C3%A9/latest.json",
    signature: "0b8ed839d9304fca56c42f861604eebbde044e8eb1a3ed1dff2c12777cc25247",
  },
  {
    name: "endpoint base path GET",
    method: "GET",
    endpoint: "https://s3.example.com/base!'()*+,:;=@[]^|$&%2F/%25/%2f/%3F%23/100%done/%zz/é/",
    key: "latest.json",
    path:
      "/base%21%27%28%29%2A%2B%2C%3A%3B%3D%40%5B%5D%5E%7C%24%26%2F/%25/%2F/%3F%23/" +
      "100%25done/%25zz/%C3%A9/bucket/latest.json",
    signature: "76ac61a81f3b291b7a7ee185c65caff03e65eb7f928f301913aaac26fd2da2aa",
  },
  {
    name: "all URI sources PUT",
    method: "PUT",
    endpoint: "https://s3.example.com/service%20root/base!'()*/",
    bucket: "bucket#?%",
    key: "work!'()*/snapshot.json.gz",
    path: "/service%20root/base%21%27%28%29%2A/bucket%23%3F%25/work%21%27%28%29%2A/snapshot.json.gz",
    signature: "05eae8ecfffa2fe14419bb9ae990513202c759abd0beb07d0a084778e5f649d2",
  },
  {
    name: "empty conditional PUT",
    method: "PUT-empty",
    key: "work!'()*/latest.json",
    path: "/bucket/work%21%27%28%29%2A/latest.json",
    signature: "559b7d88e92615c41d2b11027948fdcf31e7bb2f76be8e205015b268e9669cf2",
  },
  {
    name: "punctuation DELETE",
    method: "DELETE",
    key: "work!'()*/latest.json",
    path: "/bucket/work%21%27%28%29%2A/latest.json",
    signature: "416bfbf58bc27b902aabbcba15bcb49ca68e46da826f623319fd9dcf2682cb1b",
  },
  {
    name: "distinct Unicode GET",
    method: "GET",
    key: "cafe\u0301/café/latest.json",
    path: "/bucket/cafe%CC%81/caf%C3%A9/latest.json",
    signature: "790f050b84b03f9fb3d9e8a4baef6e7504bbd6633967e1b4dab2d2be67768a86",
  },
  {
    name: "encoded endpoint GET",
    method: "GET",
    endpoint: "https://s3.example.com/%21%27%28%29%2a/%252f/%2f/%7e/%c3%a9/%fF/",
    key: "latest.json",
    path: "/%21%27%28%29%2A/%252f/%2F/%7E/%C3%A9/%FF/bucket/latest.json",
    signature: "de7292bf62312db2a89b42ea864819b0d3df792945c5d81796152839047467e8",
  },
];

test.each(signingCases)("S3 signs the canonical URI for $name", async (vector) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T12:34:56.000Z"));
  using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
  const config = s3ClientConfig(vector.endpoint);
  if (vector.bucket) config.destination.bucket = vector.bucket;
  assert.equal(normalizeS3Bucket(config.destination.bucket), config.destination.bucket);
  normalizeS3Endpoint(config.profile.endpoint);
  const client = new S3Client(config);
  if (vector.method === "GET") await client.getJson(vector.key);
  else if (vector.method === "DELETE") await client.delete(vector.key);
  else if (vector.method === "PUT") {
    await client.putBuffer(vector.key, Buffer.from("snapshot"), "application/gzip", { ifAbsent: true });
  } else {
    await client.putBuffer(vector.key, Buffer.alloc(0), "application/json", { ifMatch: '"revision"' });
  }
  assert.equal(fetch.mock.calls.length, 1);
  const [input, init] = fetch.mock.calls[0] ?? [];
  const url = new URL(String(input));
  assert.equal(url.pathname, vector.path);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(init?.method, vector.method === "PUT-empty" ? "PUT" : vector.method);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("x-amz-date"), "20261107T123456Z");
  assert.equal(headers.get("x-amz-security-token"), "private-session-token");
  const signedHeaders =
    vector.method === "GET"
      ? "accept-encoding;host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
      : vector.method === "DELETE"
        ? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
        : vector.method === "PUT"
          ? "content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token"
          : "content-type;host;if-match;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  assert.equal(
    headers.get("authorization"),
    "AWS4-HMAC-SHA256 Credential=private-access/20261107/us-east-1/s3/aws4_request, " +
      `SignedHeaders=${signedHeaders}, Signature=${vector.signature}`,
  );
});

test("S3 sends canonical paths literally over the network, including encoded controls", async () => {
  const server = await startS3TestServer((_request, response) => response.end('{"ok":true}'));
  try {
    const config = s3ClientConfig(`${server.url}/base!'()*/%2f/%252f/`);
    config.destination.bucket = "bucket?#%";
    await new S3Client(config).getJson("prefix!'()*/literal%2F/\u0000\n\u001b\u007f\u0080/latest.json");
    assert.equal(server.requests.length, 1);
    assert.equal(
      server.requests[0]?.path,
      "/base%21%27%28%29%2A/%2F/%252f/bucket%3F%23%25/prefix%21%27%28%29%2A/" +
        "literal%252F/%00%0A%1B%7F%C2%80/latest.json",
    );
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});
