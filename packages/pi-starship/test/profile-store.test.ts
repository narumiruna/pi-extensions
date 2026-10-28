import assert from "node:assert/strict";
import fs, {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import {
  archiveConfigDocument,
  createProfile,
  deleteHistory,
  deleteProfile,
  duplicateProfile,
  listHistory,
  listProfiles,
  normalizeProfileName,
  readHistory,
  readProfile,
  renameProfile,
  saveProfile,
} from "../src/profile-store.js";

const roots: string[] = [];
function fixture(): { root: string; settingsPath: string; store: string; profiles: string; history: string } {
  // Canonical paths keep expected snapshot paths stable across macOS /var aliases.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-starship-store-"));
  roots.push(root);
  const settingsPath = join(root, "agent", "pi-starship.toml");
  const store = join(dirname(settingsPath), "pi-starship");
  return { root, settingsPath, store, profiles: join(store, "profiles"), history: join(store, "history") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("missing reads create no directories, locks, or active configuration", () => {
  const { root, settingsPath } = fixture();
  assert.deepEqual(listProfiles(settingsPath), []);
  assert.deepEqual(listHistory(settingsPath), []);
  assert.throws(() => readProfile(settingsPath, "Missing"), /missing/iu);
  assert.deepEqual(readdirSync(root), []);
});

test("profile CRUD and duplication preserve exact raw text, including malformed TOML", () => {
  const { settingsPath, profiles } = fixture();
  const raw = "\ufeff# café 🐈\r\nfuture = 'unrecognized'\r\n[broken\r\n\r\n";
  const first = createProfile(settingsPath, "Original", raw);
  assert.equal(first.rawDocument, raw);
  assert.ok(readFileSync(first.path).equals(Buffer.from(raw)));
  assert.equal(readProfile(settingsPath, first.name).rawDocument, raw);
  assert.deepEqual(
    listProfiles(settingsPath).map((entry) => entry.name),
    ["Original"],
  );
  const copied = duplicateProfile(settingsPath, first.name, "Copy", first);
  assert.equal(copied.rawDocument, raw);
  assert.notEqual(copied.identity.ino, first.identity.ino);
  const renamed = renameProfile(settingsPath, copied.name, "Renamed", copied);
  assert.equal(renamed.rawDocument, raw);
  assert.equal(existsSync(copied.path), false);
  const saved = saveProfile(settingsPath, renamed.name, "# repaired\nformat = '$model'\n", renamed);
  assert.equal(saved.rawDocument, "# repaired\nformat = '$model'\n");
  assert.equal(readFileSync(first.path, "utf8"), raw);
  deleteProfile(settingsPath, saved.name, saved);
  assert.deepEqual(readdirSync(profiles), ["Original.toml"]);
  assert.equal(existsSync(settingsPath), false);
});

test("new names normalize to NFC without silently trimming or changing forbidden text", () => {
  const { settingsPath } = fixture();
  assert.equal(normalizeProfileName("cafe\u0301"), "café");
  const document = createProfile(settingsPath, "cafe\u0301", "# exact\n");
  assert.equal(document.name, "café");
  assert.equal(readProfile(settingsPath, "cafe\u0301").path, document.path);
  assert.deepEqual(
    listProfiles(settingsPath).map((entry) => entry.name),
    ["café"],
  );
  assert.equal(normalizeProfileName("a".repeat(80)), "a".repeat(80));
  assert.equal(normalizeProfileName("🦊".repeat(62)), "🦊".repeat(62));
  assert.equal(normalizeProfileName("Desk layout.v2"), "Desk layout.v2");
});

for (const name of [
  "",
  " ",
  " name",
  "name\t",
  "name\u00a0",
  ".",
  "..",
  ".hidden",
  "name.",
  "a/b",
  "a\\b",
  'a"b',
  "a:b",
  "a<b",
  "a>b",
  "a|b",
  "a?b",
  "a*b",
  "a\u0000b",
  "a\u001bb",
  "a\u007fb",
  "a\u0085b",
  "a\u202eb",
  "a\ud800b",
  "CON",
  "con.anything",
  "PrN",
  "AUX",
  "NUL",
  "COM1",
  "COM9.extra",
  "LPT1",
  "LPT²",
  "CONIN$",
  "CONOUT$",
  "CLOCK$",
  "a".repeat(81),
  "🦊".repeat(63),
]) {
  test(`unsafe or overlong profile name is rejected: ${JSON.stringify(name)}`, () => {
    const { root, settingsPath } = fixture();
    assert.throws(() => createProfile(settingsPath, name, "# raw\n"), /Invalid profile name/u);
    assert.deepEqual(readdirSync(root), []);
  });
}

test("case-insensitive and Unicode collisions never overwrite existing destinations", () => {
  const { settingsPath } = fixture();
  const original = createProfile(settingsPath, "Straße", "# first\n");
  for (const name of ["Straße", "STRAẞE", "STRASSE", "strasse"]) {
    assert.throws(() => createProfile(settingsPath, name, "# replace\n"), /already exists/u);
  }
  assert.throws(() => renameProfile(settingsPath, original.name, "STRASSE", original), /Case-only/u);
  const other = createProfile(settingsPath, "Other", "# other\n");
  assert.throws(() => renameProfile(settingsPath, other.name, "STRASSE", other), /already exists/u);
  assert.throws(() => duplicateProfile(settingsPath, other.name, "strasse", other), /already exists/u);
  assert.equal(readProfile(settingsPath, original.name).rawDocument, "# first\n");
  assert.equal(readProfile(settingsPath, other.name).rawDocument, "# other\n");
});

test("enumeration skips nonregular documents, unsafe names, and non-TOML files", () => {
  const { root, settingsPath, profiles } = fixture();
  createProfile(settingsPath, "Good", "[invalid");
  writeFileSync(join(profiles, ".hidden.toml"), "# hidden");
  writeFileSync(join(profiles, "CON.toml"), "# reserved");
  writeFileSync(join(profiles, "note.txt"), "# note");
  mkdirSync(join(profiles, "Directory.toml"));
  const outside = join(root, "outside.toml");
  writeFileSync(outside, "# do not follow");
  symlinkSync(outside, join(profiles, "Link.toml"));
  symlinkSync(join(root, "absent.toml"), join(profiles, "Dangling.toml"));
  assert.deepEqual(
    listProfiles(settingsPath).map((entry) => entry.name),
    ["Good"],
  );
  assert.throws(() => readProfile(settingsPath, "Link"), /Not a regular/u);
  assert.throws(() => createProfile(settingsPath, "Link", "# replace"), /already exists/u);
  assert.equal(readFileSync(outside, "utf8"), "# do not follow");
});

test("trusted settings-directory and home symlink ancestors are supported", () => {
  const { root } = fixture();
  const actualHome = join(root, "actual-home");
  mkdirSync(actualHome);
  const linkedHome = join(root, "linked-home");
  symlinkSync(actualHome, linkedHome, "dir");
  const settingsPath = join(linkedHome, "agent", "pi-starship.toml");
  assert.deepEqual(listProfiles(settingsPath), []);
  assert.equal(existsSync(join(actualHome, "agent")), false);
  const profile = createProfile(settingsPath, "Trusted", "# raw");
  assert.equal(profile.path, join(actualHome, "agent", "pi-starship", "profiles", "Trusted.toml"));
  assert.equal(listProfiles(settingsPath)[0].rawDocument, "# raw");
  const linkedAgent = join(root, "linked-agent");
  symlinkSync(join(actualHome, "agent"), linkedAgent, "dir");
  assert.equal(readProfile(join(linkedAgent, "pi-starship.toml"), profile.name).path, profile.path);
  assert.equal(readHistory(settingsPath, archiveConfigDocument(settingsPath, "# old").name).rawDocument, "# old");
});

for (const target of ["pi-starship", "profiles", "history"] as const) {
  test(`reads and writes reject a symlink directory: ${target}`, () => {
    const { root, settingsPath, store, profiles, history } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    const link = target === "pi-starship" ? store : target === "profiles" ? profiles : history;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, "dir");
    if (target === "history") {
      assert.throws(() => listHistory(settingsPath), /safe directory/u);
      assert.throws(() => archiveConfigDocument(settingsPath, "# previous"), /safe directory/u);
    } else {
      assert.throws(() => listProfiles(settingsPath), /safe directory/u);
      assert.throws(() => createProfile(settingsPath, "New", "# candidate"), /safe directory/u);
    }
    assert.deepEqual(readdirSync(outside), []);
  });
}

test("new directories and documents have private POSIX permissions", () => {
  if (process.platform === "win32") return;
  const { settingsPath, store, profiles, history } = fixture();
  const profile = createProfile(settingsPath, "Private", "# profile");
  const archive = archiveConfigDocument(settingsPath, "# old");
  for (const directory of [dirname(settingsPath), store, profiles, history]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  for (const path of [profile.path, archive.path]) assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = saveProfile(settingsPath, profile.name, "# saved", profile);
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
});

test("all profile mutations reject stale raw bytes and replaced file identity", () => {
  const { settingsPath } = fixture();
  const original = createProfile(settingsPath, "Guarded", "# original");
  writeFileSync(original.path, "# external change");
  for (const operation of [
    () => saveProfile(settingsPath, original.name, "# draft", original),
    () => renameProfile(settingsPath, original.name, "Moved", original),
    () => duplicateProfile(settingsPath, original.name, "Copy", original),
    () => deleteProfile(settingsPath, original.name, original),
  ]) {
    assert.throws(operation, /changed since review/u);
  }
  const current = readProfile(settingsPath, original.name);
  const replacement = `${current.path}.external`;
  writeFileSync(replacement, current.rawBytes);
  renameSync(replacement, current.path);
  assert.throws(() => saveProfile(settingsPath, current.name, "# draft", current), /changed since review/u);
  assert.equal(readProfile(settingsPath, current.name).rawDocument, "# external change");
  assert.deepEqual(
    listProfiles(settingsPath).map((entry) => entry.name),
    ["Guarded"],
  );
});

test("review snapshots cannot target a different settings root or profile", () => {
  const first = fixture();
  const second = fixture();
  const source = createProfile(first.settingsPath, "Name", "# same");
  const other = createProfile(second.settingsPath, "Name", "# same");
  assert.throws(() => deleteProfile(second.settingsPath, other.name, source), /changed since review/u);
  const sibling = createProfile(first.settingsPath, "Other", source.rawDocument);
  assert.throws(() => saveProfile(first.settingsPath, sibling.name, "# draft", source), /changed since review/u);
});

test("no-op save and rename preserve the existing file identity", () => {
  const { settingsPath } = fixture();
  const profile = createProfile(settingsPath, "Same", "# raw");
  assert.deepEqual(saveProfile(settingsPath, profile.name, profile.rawDocument, profile), profile);
  assert.deepEqual(renameProfile(settingsPath, profile.name, profile.name, profile), profile);
});

test("malformed UTF-8 profiles and lossy input strings are never decoded into replacements", () => {
  const { settingsPath, profiles } = fixture();
  createProfile(settingsPath, "Good", "# raw");
  writeFileSync(join(profiles, "Invalid.toml"), Buffer.from([0xff, 0x00, 0xfe]));
  const invalid = readProfile(settingsPath, "Invalid");
  assert.equal(invalid.rawDocument, undefined);
  assert.match(invalid.readError ?? "", /not valid UTF-8/u);
  assert.deepEqual(
    listProfiles(settingsPath).map((entry) => entry.name),
    ["Good", "Invalid"],
  );
  const copy = duplicateProfile(settingsPath, invalid.name, "Invalid-copy", invalid);
  assert.ok(copy.rawBytes.equals(invalid.rawBytes));
  assert.equal(copy.rawDocument, undefined);
  const renamed = renameProfile(settingsPath, copy.name, "Invalid-renamed", copy);
  assert.ok(renamed.rawBytes.equals(invalid.rawBytes));
  deleteProfile(settingsPath, renamed.name, renamed);
  assert.equal(existsSync(renamed.path), false);
  assert.equal(saveProfile(settingsPath, invalid.name, "# repaired", invalid).rawDocument, "# repaired");
  assert.throws(() => createProfile(settingsPath, "Lossy", "\ud800"), /lossless UTF-8/u);
  assert.equal(existsSync(join(profiles, "Lossy.toml")), false);
});

test("history publishes independent exact-byte copies and has no automatic pruning", () => {
  const { settingsPath, history } = fixture();
  const raw = "# old\r\nfuture = '🌌'\r\n[invalid\n";
  const first = archiveConfigDocument(settingsPath, raw);
  const second = archiveConfigDocument(settingsPath, raw);
  assert.notEqual(first.name, second.name);
  assert.notEqual(statSync(first.path).ino, statSync(second.path).ino);
  assert.equal(readHistory(settingsPath, first.name).rawDocument, raw);
  assert.ok(readFileSync(first.path).equals(Buffer.from(raw)));
  assert.equal(listHistory(settingsPath).length, 2);
  assert.equal(existsSync(settingsPath), false);
  assert.equal(
    readdirSync(history).some((name) => name.startsWith(".tmp-")),
    false,
  );
  const selected = readHistory(settingsPath, first.name);
  deleteHistory(settingsPath, selected.name, selected);
  assert.equal(listHistory(settingsPath).length, 1);
  assert.equal(readFileSync(second.path, "utf8"), raw);
});

test("invalid UTF-8 recovery remains visible and preserves raw bytes without a fallback document", () => {
  const { settingsPath } = fixture();
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x0d, 0x0a]);
  const reference = archiveConfigDocument(settingsPath, bytes);
  bytes.fill(0);
  const [entry] = listHistory(settingsPath);
  assert.equal(entry.path, reference.path);
  assert.equal(entry.rawDocument, undefined);
  assert.match(entry.readError ?? "", /not valid UTF-8/u);
  assert.ok(entry.rawBytes.equals(Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x0d, 0x0a])));
  assert.ok(readFileSync(reference.path).equals(entry.rawBytes));
  deleteHistory(settingsPath, entry.name, entry);
  assert.deepEqual(listHistory(settingsPath), []);
});

test("legacy skill backups are listed without migration and cannot be deleted", () => {
  const { settingsPath, store, history } = fixture();
  mkdirSync(store, { recursive: true });
  const name = "pi-starship-202610201245.toml";
  const path = join(store, name);
  writeFileSync(path, "# legacy\r\n[invalid");
  writeFileSync(join(store, "pi-starship-not-a-date.toml"), "# skip");
  mkdirSync(join(store, "pi-starship-202610201246.toml"));
  symlinkSync(path, join(store, "pi-starship-202610201247.toml"));
  const before = lstatSync(path);
  const [entry] = listHistory(settingsPath);
  assert.equal(entry.name, name);
  assert.equal(entry.legacy, true);
  assert.equal(entry.createdAt, "2026-10-20T12:45");
  assert.equal(entry.rawDocument, "# legacy\r\n[invalid");
  assert.throws(() => deleteHistory(settingsPath, name, entry), /read-only/u);
  assert.equal(existsSync(history), false);
  assert.equal(existsSync(join(store, ".mutation-lock")), false);
  assert.equal(lstatSync(path).mtimeMs, before.mtimeMs);
});

test("history rejects impossible timestamps and extracts valid recovery time", () => {
  const { settingsPath, store, history } = fixture();
  const reference = archiveConfigDocument(settingsPath, "# recovery");
  const entry = readHistory(settingsPath, reference.name);
  assert.equal(new Date(entry.createdAt).toISOString(), entry.createdAt);
  const uuid = "12345678-1234-1234-1234-123456789abc";
  for (const name of [`2026-02-30T12-45-00.000Z-${uuid}.toml`, `2026-10-20T25-45-00.000Z-${uuid}.toml`]) {
    writeFileSync(join(history, name), "# invalid timestamp");
    assert.throws(() => readHistory(settingsPath, name), /Invalid history timestamp/u);
  }
  for (const name of ["pi-starship-202602301245.toml", "pi-starship-202613201245.toml"]) {
    writeFileSync(join(store, name), "# invalid timestamp");
    assert.throws(() => readHistory(settingsPath, name), /Invalid history timestamp/u);
  }
  assert.deepEqual(
    listHistory(settingsPath).map((document) => document.name),
    [entry.name],
  );
});

test("history APIs reject arbitrary paths and guard reviewed bytes on deletion", () => {
  const { settingsPath } = fixture();
  for (const name of [
    "../outside.toml",
    "/tmp/outside.toml",
    "pi-starship-202610201245.toml/../other",
    "unknown.toml",
  ]) {
    assert.throws(() => readHistory(settingsPath, name), /Invalid history filename/u);
  }
  const archive = archiveConfigDocument(settingsPath, "# old");
  const entry = readHistory(settingsPath, archive.name);
  writeFileSync(entry.path, "# external");
  assert.throws(() => deleteHistory(settingsPath, entry.name, entry), /changed since review/u);
  assert.equal(readFileSync(entry.path, "utf8"), "# external");
});

test("cooperative lock contention fails without guessing stale ownership or removing a lock", () => {
  const { settingsPath, store } = fixture();
  mkdirSync(join(store, ".mutation-lock"), { recursive: true });
  const lock = join(store, ".mutation-lock");
  const before = lstatSync(lock);
  assert.throws(() => createProfile(settingsPath, "Blocked", "# no"), /storage is locked/u);
  assert.throws(() => archiveConfigDocument(settingsPath, "# no"), /storage is locked/u);
  assert.equal(lstatSync(lock).ino, before.ino);
  assert.deepEqual(listProfiles(settingsPath), []);
  assert.deepEqual(listHistory(settingsPath), []);
});

function patchFs<K extends "renameSync" | "fsyncSync" | "writeFileSync" | "rmdirSync">(
  key: K,
  replacement: (original: (typeof fs)[K]) => (typeof fs)[K],
): () => void {
  const original = fs[key];
  fs[key] = replacement(original);
  syncBuiltinESMExports();
  return () => {
    fs[key] = original;
    syncBuiltinESMExports();
  };
}

test("Windows mutations flush files without unsupported directory fsync", () => {
  const { settingsPath } = fixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  let fileFlushes = 0;
  const restore = patchFs(
    "fsyncSync",
    (original) =>
      ((fd) => {
        assert.equal(fstatSync(fd).isDirectory(), false);
        fileFlushes += 1;
        return original(fd);
      }) as typeof fs.fsyncSync,
  );
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const profile = createProfile(settingsPath, "Portable", "# saved");
    const recovery = archiveConfigDocument(settingsPath, "# previous");
    assert.equal(fileFlushes, 2);
    assert.equal(readFileSync(profile.path, "utf8"), "# saved");
    assert.equal(readFileSync(recovery.path, "utf8"), "# previous");
  } finally {
    Object.defineProperty(process, "platform", platform);
    restore();
  }
});

test("failed profile publication retains old bytes and releases temporary files and lock", () => {
  const { settingsPath, profiles, store } = fixture();
  const original = createProfile(settingsPath, "Keep", "# original");
  const restore = patchFs(
    "renameSync",
    () =>
      (() => {
        throw new Error("injected rename failure");
      }) as typeof fs.renameSync,
  );
  try {
    assert.throws(() => saveProfile(settingsPath, original.name, "# changed", original), /injected rename failure/u);
  } finally {
    restore();
  }
  assert.equal(readFileSync(original.path, "utf8"), "# original");
  assert.deepEqual(readdirSync(profiles), ["Keep.toml"]);
  assert.equal(existsSync(join(store, ".mutation-lock")), false);
  assert.equal(saveProfile(settingsPath, original.name, "# recovered", original).rawDocument, "# recovered");
});

test("a source edit observed during draft publication rejects the stale profile save", () => {
  const { settingsPath, profiles } = fixture();
  const profile = createProfile(settingsPath, "Guarded", "# original");
  const restore = patchFs("fsyncSync", (original) => (fd: number) => {
    original(fd);
    if (fstatSync(fd).isFile()) writeFileSync(profile.path, "# external");
  });
  try {
    assert.throws(() => saveProfile(settingsPath, profile.name, "# draft", profile), /changed since review/u);
  } finally {
    restore();
  }
  assert.equal(readFileSync(profile.path, "utf8"), "# external");
  assert.deepEqual(readdirSync(profiles), ["Guarded.toml"]);
});

test("a write failure cleans up its incomplete temporary document", () => {
  const { settingsPath, profiles, store } = fixture();
  const restore = patchFs(
    "writeFileSync",
    () =>
      (() => {
        throw new Error("injected write failure");
      }) as typeof fs.writeFileSync,
  );
  try {
    assert.throws(() => createProfile(settingsPath, "Draft", "# draft"), /injected write failure/u);
  } finally {
    restore();
  }
  assert.deepEqual(readdirSync(profiles), []);
  assert.equal(existsSync(join(store, ".mutation-lock")), false);
  assert.equal(createProfile(settingsPath, "Draft", "# works").rawDocument, "# works");
});

for (const action of ["save", "rename", "delete"] as const) {
  test(`a post-${action} directory flush failure reports the completed mutation path`, () => {
    const { settingsPath, profiles, store } = fixture();
    const profile = createProfile(settingsPath, "Before", "# before");
    const destination = action === "rename" ? join(profiles, "After.toml") : profile.path;
    const restore = patchFs("fsyncSync", (original) => (fd: number) => {
      if (fstatSync(fd).isDirectory()) throw new Error("injected post-mutation flush failure");
      original(fd);
    });
    try {
      assert.throws(
        () => {
          if (action === "save") saveProfile(settingsPath, profile.name, "# after", profile);
          else if (action === "rename") renameProfile(settingsPath, profile.name, "After", profile);
          else deleteProfile(settingsPath, profile.name, profile);
        },
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(destination) &&
          error.message.includes("injected post-mutation flush failure"),
      );
    } finally {
      restore();
    }
    assert.equal(existsSync(join(store, ".mutation-lock")), false);
    if (action === "delete") assert.equal(existsSync(profile.path), false);
    else assert.equal(readFileSync(destination, "utf8"), action === "save" ? "# after" : "# before");
  });
}

test("a replacement lock is never removed as another operation's cleanup", () => {
  const { settingsPath, store } = fixture();
  const lock = join(store, ".mutation-lock");
  const movedLock = join(store, ".old-lock");
  const restore = patchFs(
    "writeFileSync",
    (original) =>
      ((...args: Parameters<typeof fs.writeFileSync>) => {
        original(...args);
        if (typeof args[0] === "number") {
          renameSync(lock, movedLock);
          mkdirSync(lock);
        }
      }) as typeof fs.writeFileSync,
  );
  try {
    createProfile(settingsPath, "Created", "# raw");
  } finally {
    restore();
  }
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(movedLock), true);
  assert.throws(() => createProfile(settingsPath, "Blocked", "# no"), /storage is locked/u);
});

test("lock cleanup failure is observable and retains the published document", () => {
  const { settingsPath, store } = fixture();
  const restore = patchFs(
    "rmdirSync",
    () =>
      (() => {
        throw new Error("injected lock cleanup failure");
      }) as typeof fs.rmdirSync,
  );
  try {
    assert.throws(
      () => createProfile(settingsPath, "Published", "# raw"),
      /Mutation completed but lock cleanup failed/u,
    );
  } finally {
    restore();
  }
  assert.equal(readProfile(settingsPath, "Published").rawDocument, "# raw");
  assert.equal(existsSync(join(store, ".mutation-lock")), true);
});

test("mutation and lock cleanup errors are both retained", () => {
  const { settingsPath } = fixture();
  const restoreWrite = patchFs(
    "writeFileSync",
    () =>
      (() => {
        throw new Error("injected write failure");
      }) as typeof fs.writeFileSync,
  );
  const restoreCleanup = patchFs(
    "rmdirSync",
    () =>
      (() => {
        throw new Error("injected cleanup failure");
      }) as typeof fs.rmdirSync,
  );
  try {
    assert.throws(
      () => createProfile(settingsPath, "Draft", "# no"),
      (error: unknown) => {
        return (
          error instanceof AggregateError &&
          error.errors[0].message === "injected write failure" &&
          error.errors[1].message === "injected cleanup failure"
        );
      },
    );
  } finally {
    restoreCleanup();
    restoreWrite();
  }
});

test("an external destination observed just before publication is not overwritten", () => {
  const { settingsPath, profiles } = fixture();
  const restore = patchFs(
    "writeFileSync",
    (original) =>
      ((...args: Parameters<typeof fs.writeFileSync>) => {
        const result = original(...args);
        if (typeof args[0] === "number") original(join(profiles, "Raced.toml"), "# external");
        return result;
      }) as typeof fs.writeFileSync,
  );
  try {
    assert.throws(() => createProfile(settingsPath, "Raced", "# candidate"), /already exists/u);
  } finally {
    restore();
  }
  assert.equal(readFileSync(join(profiles, "Raced.toml"), "utf8"), "# external");
  assert.deepEqual(readdirSync(profiles), ["Raced.toml"]);
});

test("backup fsync precedes rename and directory fsync follows publication", () => {
  const { settingsPath } = fixture();
  // Materialize directories so only the archive's actual publication flushes are relevant.
  archiveConfigDocument(settingsPath, "# initialize");
  const events: string[] = [];
  const restoreSync = patchFs("fsyncSync", (original) => (fd: number) => {
    events.push(fstatSync(fd).isFile() ? "file-sync" : "directory-sync");
    original(fd);
  });
  const restoreRename = patchFs("renameSync", (original) => (source, destination) => {
    events.push("rename");
    original(source, destination);
  });
  try {
    archiveConfigDocument(settingsPath, "# old");
  } finally {
    restoreRename();
    restoreSync();
  }
  assert.ok(events.indexOf("file-sync") < events.indexOf("rename"));
  assert.equal(events.at(-1), "directory-sync");
  assert.equal(events.filter((entry) => entry === "rename").length, 1);
});

test("failed recovery file flush publishes nothing and later calls can recover", () => {
  const { settingsPath, history, store } = fixture();
  archiveConfigDocument(settingsPath, "# existing");
  const restore = patchFs("fsyncSync", (original) => (fd: number) => {
    if (fstatSync(fd).isFile()) throw new Error("injected file sync failure");
    original(fd);
  });
  try {
    assert.throws(() => archiveConfigDocument(settingsPath, "# must not publish"), /injected file sync failure/u);
  } finally {
    restore();
  }
  assert.equal(readdirSync(history).length, 1);
  assert.equal(existsSync(join(store, ".mutation-lock")), false);
  archiveConfigDocument(settingsPath, "# succeeds");
  assert.equal(listHistory(settingsPath).length, 2);
});

test("a recovery copy remains published when its post-rename directory flush fails", () => {
  const { settingsPath, history, store } = fixture();
  archiveConfigDocument(settingsPath, "# existing");
  let published = false;
  const restoreRename = patchFs("renameSync", (original) => (source, destination) => {
    original(source, destination);
    published = true;
  });
  const restoreSync = patchFs("fsyncSync", (original) => (fd: number) => {
    if (published && fstatSync(fd).isDirectory()) throw new Error("injected directory sync failure");
    original(fd);
  });
  try {
    assert.throws(
      () => archiveConfigDocument(settingsPath, "# retained after uncertain durability"),
      /injected directory sync failure/u,
    );
  } finally {
    restoreSync();
    restoreRename();
  }
  assert.equal(readdirSync(history).length, 2);
  assert.ok(listHistory(settingsPath).some((entry) => entry.rawDocument === "# retained after uncertain durability"));
  assert.equal(existsSync(join(store, ".mutation-lock")), false);
});
