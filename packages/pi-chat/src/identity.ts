import { createHash, hkdfSync } from "node:crypto";
import { createRequire } from "node:module";

export { normalizeNickname } from "./nickname.js";

const require = createRequire(import.meta.url);
type HyperDht = typeof import("hyperdht")["default"];
type Sodium = typeof import("sodium-universal")["default"];
let hyperDhtImplementation: HyperDht | undefined;
let sodiumImplementation: Sodium | undefined;

function hyperDht(): HyperDht {
  hyperDhtImplementation ??= require("hyperdht") as HyperDht;
  return hyperDhtImplementation;
}

function sodium(): Sodium {
  sodiumImplementation ??= require("sodium-universal") as Sodium;
  return sodiumImplementation;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ChatIdentity {
  seed: string;
  publicKey: Buffer;
  secretKey: Buffer;
  tag: string;
}

export function createIdentity(seed: Uint8Array): ChatIdentity {
  if (seed.byteLength !== 32) throw new Error("Pi Chat identity seed must be exactly 32-byte.");
  const stableSeed = Buffer.from(seed);
  const keyPair = hyperDht().keyPair(stableSeed);
  return {
    seed: stableSeed.toString("base64url"),
    publicKey: Buffer.from(keyPair.publicKey),
    secretKey: Buffer.from(keyPair.secretKey),
    tag: identityTag(keyPair.publicKey),
  };
}

export function deriveScopedIdentity(identity: ChatIdentity, scope: string): ChatIdentity {
  if (!scope || Buffer.byteLength(scope, "utf8") > 256) {
    throw new Error("Pi Chat identity scope is invalid.");
  }
  const seed = Buffer.from(identity.seed, "base64url");
  return createIdentity(
    Buffer.from(
      hkdfSync("sha256", seed, Buffer.from("pi-chat/scoped-identity/v2", "utf8"), Buffer.from(scope, "utf8"), 32),
    ),
  );
}

export function signIdentityPayload(identity: ChatIdentity, payload: Uint8Array): string {
  const implementation = sodium();
  const signature = Buffer.alloc(implementation.crypto_sign_BYTES);
  implementation.crypto_sign_detached(signature, payload, identity.secretKey);
  return signature.toString("base64url");
}

export function verifyIdentityPayload(publicKey: Uint8Array, payload: Uint8Array, signatureValue: string): boolean {
  if (publicKey.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/u.test(signatureValue)) return false;
  const signature = Buffer.from(signatureValue, "base64url");
  const implementation = sodium();
  if (signature.byteLength !== implementation.crypto_sign_BYTES) return false;
  try {
    return implementation.crypto_sign_verify_detached(signature, payload, publicKey);
  } catch {
    return false;
  }
}

export function identityTag(publicKey: Uint8Array, characters = 12): string {
  if (characters < 12 || characters > 52) throw new Error("Identity tags use 12 to 52 characters.");
  const digest = createHash("sha256").update(publicKey).digest();
  let bits = 0;
  let bitCount = 0;
  let raw = "";
  for (const byte of digest) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && raw.length < characters) {
      bitCount -= 5;
      raw += CROCKFORD[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
    if (raw.length === characters) break;
  }
  return raw.match(/.{1,4}/gu)?.join("-") ?? raw;
}

export function formatIdentityLabel(nickname: string, publicKey: Uint8Array, characters = 12): string {
  return `${nickname}~${identityTag(publicKey, characters)}`;
}

export function uniqueIdentityTags(publicKeys: readonly Uint8Array[]): Map<string, string> {
  const fullKeys = publicKeys.map((key) => Buffer.from(key).toString("hex"));
  const result = new Map<string, string>();
  for (let length = 12; length <= 52; length += 4) {
    const grouped = new Map<string, string[]>();
    for (const [index, publicKey] of publicKeys.entries()) {
      const tag = identityTag(publicKey, length);
      const fullKey = fullKeys[index] ?? Buffer.from(publicKey).toString("hex");
      grouped.set(tag, [...(grouped.get(tag) ?? []), fullKey]);
    }
    for (const [tag, keys] of grouped) {
      const onlyKey = keys.length === 1 ? keys[0] : undefined;
      if (onlyKey && !result.has(onlyKey)) result.set(onlyKey, tag);
    }
    if (result.size === publicKeys.length) break;
  }
  return result;
}
