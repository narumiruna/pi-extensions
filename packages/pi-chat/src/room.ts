import { createHash, hkdfSync } from "node:crypto";

const PUBLIC_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;

export interface RoomDescriptor {
  kind: "private" | "public";
  label: string;
  id: string;
  topic: Buffer;
  key: Buffer;
  invite?: string;
  slug?: string;
}

export function createPrivateRoom(secret: Uint8Array): RoomDescriptor {
  if (secret.byteLength !== 32) throw new Error("Private room secrets must be 32 bytes.");
  const bytes = Buffer.from(secret);
  const topic = domainHash("pi-chat/discovery/private/v2", bytes);
  return {
    kind: "private",
    label: `private ${shortRoomId(topic)}`,
    id: topic.toString("base64url"),
    topic,
    key: deriveRoomKey(bytes),
    invite: `pichat:v2:${bytes.toString("base64url")}`,
  };
}

export function parseInvite(value: string): RoomDescriptor {
  const match = /^pichat:v[12]:([A-Za-z0-9_-]{43})$/u.exec(value.trim());
  const encodedSecret = match?.[1];
  if (!encodedSecret) throw new Error("This is not a valid Pi Chat invite.");
  const secret = Buffer.from(encodedSecret, "base64url");
  if (secret.length !== 32) throw new Error("This is not a valid Pi Chat invite.");
  return createPrivateRoom(secret);
}

export function createPublicRoom(slug: string): RoomDescriptor {
  if (!PUBLIC_SLUG.test(slug)) {
    throw new Error("A public room slug must use lowercase letters, numbers, or hyphens.");
  }
  const material = Buffer.from(`pi-chat/public/v2:${slug}`, "utf8");
  const topic = createHash("sha256").update(material).digest();
  return {
    kind: "public",
    label: `#${slug}`,
    id: topic.toString("base64url"),
    topic,
    key: deriveRoomKey(material),
    slug,
  };
}

export function legacyRoomId(room: RoomDescriptor): string | undefined {
  if (room.kind === "public" && room.slug) {
    return createHash("sha256")
      .update(Buffer.from(`pi-chat/public/v1:${room.slug}`, "utf8"))
      .digest("base64url");
  }
  const encodedSecret = /^pichat:v[12]:([A-Za-z0-9_-]{43})$/u.exec(room.invite ?? "")?.[1];
  if (!encodedSecret) return undefined;
  const secret = Buffer.from(encodedSecret, "base64url");
  return secret.length === 32 ? domainHash("pi-chat/discovery/private/v1", secret).toString("base64url") : undefined;
}

export function isCompatibleRoomId(room: RoomDescriptor, id: string): boolean {
  return room.id === id || legacyRoomId(room) === id;
}

function deriveRoomKey(material: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", material, Buffer.from("pi-chat/v2"), Buffer.from("room-handshake"), 32));
}

function domainHash(domain: string, material: Uint8Array): Buffer {
  return createHash("sha256")
    .update(domain)
    .update(Buffer.from([0]))
    .update(material)
    .digest();
}

function shortRoomId(topic: Uint8Array): string {
  return Buffer.from(topic).subarray(0, 5).toString("base64url");
}
