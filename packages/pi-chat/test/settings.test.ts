import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createPrivateRoom, createPublicRoom, legacyRoomId } from "../src/protocol.js";
import { CHAT_SETTINGS_FILE, type ChatResumeSettings, readChatSettings, updateChatSettings } from "../src/settings.js";

async function withSettings(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-settings-"));
  try {
    await run(join(root, "nested", CHAT_SETTINGS_FILE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing settings are side-effect free", async () => {
  await withSettings(async (path) => {
    assert.deepEqual(await readChatSettings(path), { kind: "missing" });
    await assert.rejects(lstat(path), { code: "ENOENT" });
  });
});

test("explicit saves are private, ordered, and preserve unknown fields", async () => {
  await withSettings(async (path) => {
    await updateChatSettings({ nickname: "Mika", widgetMode: "count" }, { settingsPath: path });
    await writeFile(path, JSON.stringify({ nickname: "Mika", widgetMode: "count", future: { keep: true } }), {
      mode: 0o600,
    });
    const first = updateChatSettings({ nickname: "One" }, { settingsPath: path });
    const second = updateChatSettings({ nickname: "Two", widgetMode: "dock" }, { settingsPath: path });
    await Promise.all([first, second]);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(document.future, { keep: true });
    assert.equal(document.nickname, "Two");
    assert.equal(document.widgetMode, "dock");
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
  });
});

test("remembered public and private rooms round-trip through a bounded active catalog", async () => {
  await withSettings(async (path) => {
    const publicRoom = createPublicRoom("pi-dev");
    const privateRoom = createPrivateRoom(Buffer.alloc(32, 13));
    const resume: ChatResumeSettings = {
      rooms: [
        { id: publicRoom.id, kind: "public", slug: "pi-dev" },
        { id: privateRoom.id, kind: "private", invite: privateRoom.invite ?? "" },
      ],
      activeRoomId: privateRoom.id,
      surface: "chat",
    };
    await updateChatSettings(
      { nickname: "Mika", identitySeed: Buffer.alloc(32, 4).toString("base64url"), resume },
      { settingsPath: path },
    );
    const loaded = await readChatSettings(path);
    assert.equal(loaded.kind, "loaded");
    if (loaded.kind === "loaded") assert.deepEqual(loaded.settings.resume, resume);
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
  });
});

test("resume updates preserve nested unknown fields and explicit clearing removes only resume", async () => {
  await withSettings(async (path) => {
    const room = createPublicRoom("pi-dev");
    await updateChatSettings({ nickname: "Mika" }, { settingsPath: path });
    await writeFile(
      path,
      JSON.stringify({
        nickname: "Mika",
        identitySeed: Buffer.alloc(32, 4).toString("base64url"),
        future: { keep: true },
        resume: {
          rooms: [{ id: room.id, kind: "public", slug: "pi-dev", roomFuture: 1 }],
          activeRoomId: room.id,
          surface: "chat",
          resumeFuture: { keep: true },
        },
      }),
      { mode: 0o600 },
    );
    await updateChatSettings(
      {
        resume: {
          rooms: [{ id: room.id, kind: "public", slug: "pi-dev" }],
          activeRoomId: room.id,
          surface: "pi",
        },
      },
      { settingsPath: path },
    );
    const updated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(updated.future, { keep: true });
    assert.deepEqual(Reflect.get(updated.resume as object, "resumeFuture"), { keep: true });
    const rooms = Reflect.get(updated.resume as object, "rooms") as Record<string, unknown>[];
    assert.equal(rooms[0]?.roomFuture, 1);
    await updateChatSettings({ resume: null }, { settingsPath: path });
    const cleared = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(cleared, "resume"), false);
    assert.deepEqual(cleared.future, { keep: true });
  });
});

test("v1 room ids and invites migrate in memory without side effects and preserve unknown fields", async () => {
  await withSettings(async (path) => {
    const publicRoom = createPublicRoom("legacy-public");
    const privateRoom = createPrivateRoom(Buffer.alloc(32, 24));
    const publicLegacyId = legacyRoomId(publicRoom);
    const privateLegacyId = legacyRoomId(privateRoom);
    assert.ok(publicLegacyId);
    assert.ok(privateLegacyId);
    const v1Invite = (privateRoom.invite ?? "").replace("pichat:v2:", "pichat:v1:");
    const document = {
      nickname: "Legacy",
      identitySeed: Buffer.alloc(32, 25).toString("base64url"),
      resume: {
        rooms: [
          {
            id: publicLegacyId,
            kind: "public",
            slug: "legacy-public",
            roomFuture: "keep-public",
          },
          {
            id: privateLegacyId,
            kind: "private",
            invite: v1Invite,
            roomFuture: "keep-private",
          },
        ],
        activeRoomId: privateLegacyId,
        surface: "pi",
        resumeFuture: true,
      },
    };
    await updateChatSettings({ nickname: "Legacy" }, { settingsPath: path });
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const before = await readFile(path, "utf8");
    const loaded = await readChatSettings(path);
    assert.equal(loaded.kind, "loaded");
    if (loaded.kind !== "loaded" || !loaded.settings.resume) return;
    assert.deepEqual(
      loaded.settings.resume.rooms.map(({ id }) => id),
      [publicRoom.id, privateRoom.id],
    );
    assert.equal(loaded.settings.resume.activeRoomId, privateRoom.id);
    assert.equal(await readFile(path, "utf8"), before);

    await updateChatSettings({ resume: loaded.settings.resume }, { settingsPath: path });
    const migrated = JSON.parse(await readFile(path, "utf8")) as {
      resume: { rooms: Record<string, unknown>[]; resumeFuture: boolean };
    };
    assert.deepEqual(
      migrated.resume.rooms.map(({ id, roomFuture }) => ({ id, roomFuture })),
      [
        { id: publicRoom.id, roomFuture: "keep-public" },
        { id: privateRoom.id, roomFuture: "keep-private" },
      ],
    );
    assert.equal(migrated.resume.resumeFuture, true);
  });
});

test("resume validation rejects inconsistent, duplicate, and excessive room catalogs", async () => {
  await withSettings(async (path) => {
    const room = createPublicRoom("pi-dev");
    await updateChatSettings({ nickname: "Mika" }, { settingsPath: path });
    const invalidResumeValues = [
      { rooms: [], activeRoomId: room.id, surface: "chat" },
      {
        rooms: [{ id: "wrong", kind: "public", slug: "pi-dev" }],
        activeRoomId: "wrong",
        surface: "chat",
      },
      {
        rooms: [
          { id: room.id, kind: "public", slug: "pi-dev" },
          { id: room.id, kind: "public", slug: "pi-dev" },
        ],
        activeRoomId: room.id,
        surface: "chat",
      },
      {
        rooms: Array.from({ length: 17 }, (_, index) => {
          const value = createPublicRoom(`room-${index}`);
          return { id: value.id, kind: "public", slug: `room-${index}` };
        }),
        activeRoomId: createPublicRoom("room-0").id,
        surface: "pi",
      },
    ];
    for (const resume of invalidResumeValues) {
      await writeFile(
        path,
        JSON.stringify({
          nickname: "Mika",
          identitySeed: Buffer.alloc(32, 4).toString("base64url"),
          resume,
        }),
        { mode: 0o600 },
      );
      assert.equal((await readChatSettings(path)).kind, "invalid");
    }
    await writeFile(
      path,
      JSON.stringify({
        nickname: "Mika",
        resume: {
          rooms: [{ id: room.id, kind: "public", slug: "pi-dev" }],
          activeRoomId: room.id,
          surface: "chat",
        },
      }),
      { mode: 0o600 },
    );
    assert.equal((await readChatSettings(path)).kind, "invalid");
  });
});

test("identity creation is explicit and preserved by preference updates", async () => {
  await withSettings(async (path) => {
    const settings = await updateChatSettings(
      { nickname: "Mika", identitySeed: Buffer.alloc(32, 7).toString("base64url") },
      { settingsPath: path },
    );
    assert.equal(settings.identitySeed, Buffer.alloc(32, 7).toString("base64url"));
    await updateChatSettings({ widgetMode: "off" }, { settingsPath: path });
    const loaded = await readChatSettings(path);
    assert.equal(loaded.kind, "loaded");
    if (loaded.kind === "loaded") {
      assert.equal(loaded.settings.identitySeed, settings.identitySeed);
      assert.equal(loaded.settings.widgetMode, "off");
    }
  });
});

test("malformed, invalid, symlinked, and oversized settings fail closed", async () => {
  await withSettings(async (path) => {
    await updateChatSettings({ nickname: "Mika" }, { settingsPath: path });
    for (const contents of ["{secret-marker", '{"nickname":"bad\\nname"}']) {
      await writeFile(path, contents, "utf8");
      const loaded = await readChatSettings(path);
      assert.equal(loaded.kind, "invalid");
      assert.doesNotMatch(loaded.kind === "invalid" ? loaded.reason : "", /secret-marker/u);
      await assert.rejects(updateChatSettings({ widgetMode: "off" }, { settingsPath: path }));
      assert.equal(await readFile(path, "utf8"), contents);
    }
    await writeFile(path, Buffer.alloc(70 * 1024));
    assert.equal((await readChatSettings(path)).kind, "invalid");
  });
});

test("invalid UTF-8 and symlink paths fail closed without exposing file bytes", async () => {
  await withSettings(async (path) => {
    await updateChatSettings({ nickname: "Mika" }, { settingsPath: path });
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
    await writeFile(path, invalidUtf8);
    const invalid = await readChatSettings(path);
    assert.equal(invalid.kind, "invalid");
    assert.match(invalid.kind === "invalid" ? invalid.reason : "", /UTF-8/u);
    assert.deepEqual(await readFile(path), invalidUtf8);

    if (process.platform !== "win32") {
      const target = `${path}.target`;
      await writeFile(target, '{"nickname":"Secret"}', { mode: 0o600 });
      await rm(path);
      await symlink(target, path);
      const linked = await readChatSettings(path);
      assert.equal(linked.kind, "invalid");
      await assert.rejects(updateChatSettings({ widgetMode: "off" }, { settingsPath: path }));
      assert.equal(await readFile(target, "utf8"), '{"nickname":"Secret"}');
    }
  });
});

test("publication failure and abort preserve the previous valid document", async () => {
  await withSettings(async (path) => {
    await updateChatSettings({ nickname: "Mika" }, { settingsPath: path });
    const before = await readFile(path, "utf8");
    await assert.rejects(
      updateChatSettings(
        { nickname: "Other" },
        { settingsPath: path, beforeRename: async () => Promise.reject(new Error("stop")) },
      ),
      /stop/u,
    );
    assert.equal(await readFile(path, "utf8"), before);
    if (process.platform !== "win32") {
      await assert.rejects(
        updateChatSettings(
          { nickname: "Other" },
          {
            settingsPath: path,
            setPrivateMode: async () => Promise.reject(new Error("chmod failed")),
          },
        ),
        /chmod failed/u,
      );
      assert.equal(await readFile(path, "utf8"), before);
    }
    await chmod(path, 0o600);
  });
});
