import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createIdentity,
  deriveScopedIdentity,
  formatIdentityLabel,
  identityTag,
  normalizeNickname,
  signIdentityPayload,
  verifyIdentityPayload,
} from "../src/identity.js";

const SEED = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

test("normalizes safe Unicode nicknames and rejects terminal or bidi controls", () => {
  assert.equal(normalizeNickname("  Ｍｉｋａ  "), "Mika");
  assert.equal(normalizeNickname("開發者👩🏽‍💻"), "開發者👩🏽‍💻");
  assert.equal(normalizeNickname("a".repeat(25)), undefined);
  assert.equal(normalizeNickname("bad\nname"), undefined);
  assert.equal(normalizeNickname("bad\u001b[31m"), undefined);
  assert.equal(normalizeNickname("left\u202eright"), undefined);
});

test("derives a stable human-readable tag from a public key", () => {
  const publicKey = Buffer.alloc(32, 0xa5);
  const first = identityTag(publicKey);
  assert.match(first, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/u);
  assert.equal(identityTag(publicKey), first);
  assert.notEqual(identityTag(Buffer.alloc(32, 0xa6)), first);
  assert.equal(formatIdentityLabel("Mika", publicKey), `Mika~${first}`);
});

test("creates deterministic DHT identity material from a 32-byte seed", () => {
  const first = createIdentity(SEED);
  const second = createIdentity(SEED);
  assert.equal(first.seed, SEED.toString("base64url"));
  assert.equal(first.publicKey.length, 32);
  assert.deepEqual(first.publicKey, second.publicKey);
  assert.equal(first.tag, second.tag);
  assert.throws(() => createIdentity(Buffer.alloc(31)), /32-byte/u);
});

test("signs immutable payloads and derives unlinkable stable scoped identities", () => {
  const identity = createIdentity(SEED);
  const payload = Buffer.from("pi-chat signed payload", "utf8");
  const signature = signIdentityPayload(identity, payload);
  assert.equal(verifyIdentityPayload(identity.publicKey, payload, signature), true);
  assert.equal(verifyIdentityPayload(identity.publicKey, Buffer.from("mutated"), signature), false);
  assert.equal(verifyIdentityPayload(Buffer.alloc(32, 9), payload, signature), false);

  const first = deriveScopedIdentity(identity, "directory:#pi-dev");
  const repeated = deriveScopedIdentity(identity, "directory:#pi-dev");
  const other = deriveScopedIdentity(identity, "directory:#typescript");
  assert.deepEqual(first.publicKey, repeated.publicKey);
  assert.notDeepEqual(first.publicKey, identity.publicKey);
  assert.notDeepEqual(first.publicKey, other.publicKey);
});
