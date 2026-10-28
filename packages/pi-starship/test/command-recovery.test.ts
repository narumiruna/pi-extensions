import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type CommitOptions, captureCommitExpectation, commitActiveDocument } from "../src/command-commit.js";
import type { WorkflowOwner } from "../src/command-configuration.js";
import {
  atomicRestoreConfigDocument,
  atomicSaveConfigDocument,
  loadStarshipConfig,
  readConfigDocumentSnapshot,
  validateConfigDocument,
} from "../src/config.js";
import { archiveConfigDocument } from "../src/profile-store.js";

const old = "# exact comment\r\nformat = 'old'\r\nfuture = true\r\n";
const next = "# candidate\nformat = 'new'\n";

function fixture(...args: [] | [string | Buffer | undefined]) {
  const raw = args.length === 0 ? old : args[0];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "starship-recovery-")));
  const path = join(root, "pi-starship.toml");
  if (raw !== undefined) writeFileSync(path, raw);
  let loaded = loadStarshipConfig(path);
  let revision = 0;
  const controller = new AbortController();
  const owner: WorkflowOwner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  const options: CommitOptions = {
    settingsPath: path,
    getLoaded: () => loaded,
    getLoadedRevision: () => revision,
    apply(value) {
      loaded = value;
      revision += 1;
    },
  };
  const ctx = createMockContext({ mode: "tui", hasUI: true }).ctx;
  const candidate = validateConfigDocument(path, next);
  const commit = (allowInvalid = false, checkCandidate?: () => void) =>
    commitActiveDocument(
      ctx,
      options,
      candidate,
      owner,
      captureCommitExpectation(options),
      allowInvalid,
      checkCandidate,
    );
  const history = () => {
    const directory = join(root, "pi-starship", "history");
    return existsSync(directory)
      ? readdirSync(directory)
          .filter((file) => file.endsWith(".toml"))
          .map((file) => join(directory, file))
      : [];
  };
  return {
    root,
    path,
    options,
    ctx,
    candidate,
    owner,
    controller,
    commit,
    history,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("managed replacement archives exact bytes before publication and uses private files", async () => {
  const f = fixture();
  try {
    f.options.save = (path, raw) => {
      assert.equal(f.history().length, 1);
      assert.equal(readFileSync(f.history()[0] ?? "", "utf8"), old);
      assert.equal(readFileSync(path, "utf8"), old);
      return atomicSaveConfigDocument(path, raw);
    };
    assert.equal(await f.commit(), "applied");
    assert.equal(readFileSync(f.path, "utf8"), next);
    assert.equal(f.options.getLoaded().rawDocument, next);
    if (process.platform !== "win32") {
      assert.equal(statSync(f.path).mode & 0o777, 0o600);
      assert.equal(statSync(f.history()[0] ?? "").mode & 0o777, 0o600);
    }
  } finally {
    f.cleanup();
  }
});

test("missing and byte-identical active documents need no recovery copy", async () => {
  for (const raw of [undefined, next]) {
    const f = fixture(raw);
    try {
      let archived = false;
      f.options.archive = () => {
        archived = true;
        throw new Error("must not archive");
      };
      assert.equal(await f.commit(), "applied");
      assert.equal(archived, false);
      assert.deepEqual(f.history(), []);
    } finally {
      f.cleanup();
    }
  }
});

test("equivalent fresh-loaded getters remain compatible without revision tracking", async () => {
  const f = fixture();
  try {
    f.options.getLoaded = () => loadStarshipConfig(f.path);
    delete f.options.getLoadedRevision;
    assert.equal(await f.commit(), "applied");
    assert.equal(readFileSync(f.path, "utf8"), next);
  } finally {
    f.cleanup();
  }
});

test("backup publication failure prevents active publication and runtime application", async () => {
  const f = fixture();
  try {
    f.options.archive = () => {
      throw new Error("backup disk full");
    };
    f.options.save = () => {
      throw new Error("save must not run");
    };
    await assert.rejects(f.commit(), /backup disk full/u);
    assert.equal(readFileSync(f.path, "utf8"), old);
    assert.equal(f.options.getLoaded().rawDocument, old);
  } finally {
    f.cleanup();
  }
});

test("active write failure retains the already published recovery copy", async () => {
  const f = fixture();
  try {
    f.options.save = () => {
      throw new Error("active disk full");
    };
    await assert.rejects(f.commit(), /not saved.*active disk full.*Recovery copy retained/u);
    assert.equal(readFileSync(f.path, "utf8"), old);
    assert.equal(readFileSync(f.history()[0] ?? "", "utf8"), old);
  } finally {
    f.cleanup();
  }
});

test("directory durability failure after active rename rolls back the owned publication", async () => {
  if (process.platform === "win32") return;
  const f = fixture();
  try {
    f.options.save = (path, raw) =>
      atomicSaveConfigDocument(path, raw, {
        fsyncSync() {
          throw new Error("directory flush failed");
        },
      });
    await assert.rejects(
      f.commit(),
      /directory flush failed.*previous configuration was restored.*Recovery copy retained/u,
    );
    assert.equal(readFileSync(f.path, "utf8"), old);
    assert.equal(f.options.getLoaded().rawDocument, old);
    assert.equal(f.history().length, 1);
  } finally {
    f.cleanup();
  }
});

test("failed runtime application restores exact prior bytes and keeps recovery", async () => {
  const f = fixture();
  try {
    const apply = f.options.apply;
    f.options.apply = (value, ctx) => {
      if (value.rawDocument === next) throw new Error("collector rejected candidate");
      apply(value, ctx);
    };
    await assert.rejects(f.commit(), /collector rejected candidate.*previous configuration was restored/u);
    assert.equal(readFileSync(f.path, "utf8"), old);
    assert.equal(f.options.getLoaded().rawDocument, old);
    assert.equal(f.history().length, 1);
  } finally {
    f.cleanup();
  }
});

test("runtime rollback failure reports recovery and active paths", async () => {
  const f = fixture();
  try {
    f.options.apply = () => {
      throw new Error("runtime broken");
    };
    await assert.rejects(f.commit(), /Restoring.*also failed.*runtime broken.*Active path:.*Recovery copy retained/u);
    assert.equal(readFileSync(f.path, "utf8"), old);
    assert.equal(f.history().length, 1);
  } finally {
    f.cleanup();
  }
});

test("disk rollback failure leaves a recovery copy and reports the failure", async () => {
  const f = fixture();
  try {
    f.options.apply = () => {
      throw new Error("apply failed");
    };
    f.options.restore = () => {
      throw new Error("rollback disk full");
    };
    await assert.rejects(f.commit(), /rollback disk full.*Recovery copy retained/u);
    assert.equal(readFileSync(f.path, "utf8"), next);
    assert.equal(readFileSync(f.history()[0] ?? "", "utf8"), old);
  } finally {
    f.cleanup();
  }
});

for (const external of ["in-place", "replace", "delete"] as const) {
  test(`runtime failure preserves newer external ${external} changes`, async () => {
    const f = fixture();
    try {
      f.options.apply = () => {
        if (external === "in-place") writeFileSync(f.path, "format = 'external'\n");
        if (external === "replace") {
          writeFileSync(`${f.path}.new`, next);
          renameSync(`${f.path}.new`, f.path);
        }
        if (external === "delete") rmSync(f.path);
        throw new Error("runtime failed");
      };
      await assert.rejects(f.commit(), /Restoring.*also failed.*Recovery copy retained/u);
      if (external === "delete") assert.equal(existsSync(f.path), false);
      else assert.equal(readFileSync(f.path, "utf8"), external === "replace" ? next : "format = 'external'\n");
      assert.equal(f.history().length, 1);
    } finally {
      f.cleanup();
    }
  });
}

test("external edits made during recovery publication are never overwritten", async () => {
  const f = fixture();
  try {
    f.options.archive = (path, bytes) => {
      const archived = archiveConfigDocument(path, bytes);
      writeFileSync(path, "format = 'external'\n");
      return archived;
    };
    await assert.rejects(f.commit(), /newer file was preserved/u);
    assert.equal(readFileSync(f.path, "utf8"), "format = 'external'\n");
    assert.equal(f.history().length, 1);
  } finally {
    f.cleanup();
  }
});

test("candidate changes before or after recovery publication block active writes", async () => {
  for (const changedAt of [1, 2]) {
    const f = fixture();
    try {
      let checks = 0;
      await assert.rejects(
        f.commit(false, () => {
          if (++checks === changedAt) throw new Error("candidate changed");
        }),
        /candidate changed/u,
      );
      assert.equal(readFileSync(f.path, "utf8"), old);
      assert.equal(f.history().length, changedAt - 1);
    } finally {
      f.cleanup();
    }
  }
});

test("invalid active files block normal replacement but explicit recovery preserves raw non-UTF8 bytes", async () => {
  const invalid = Buffer.from([0xff, 0xfe, 0, 10]);
  const f = fixture(invalid);
  try {
    await assert.rejects(f.commit(), /invalid.*explicit repair or recovery/u);
    assert.deepEqual(f.history(), []);
    assert.deepEqual(readFileSync(f.path), invalid);
    assert.equal(await f.commit(true), "applied");
    assert.deepEqual(readFileSync(f.history()[0] ?? ""), invalid);
  } finally {
    f.cleanup();
  }
});

test("a stale loaded document cannot overwrite an unseen external version", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, "format = 'unseen'\n");
    await assert.rejects(f.commit(), /differs from the loaded document/u);
    assert.equal(readFileSync(f.path, "utf8"), "format = 'unseen'\n");
    assert.deepEqual(f.history(), []);
  } finally {
    f.cleanup();
  }
});

for (const change of ["owner", "revision", "disk", "creation", "deletion"] as const) {
  test(`queued commit revalidates ${change} after asynchronous admission`, async () => {
    const f = fixture(change === "creation" ? undefined : old);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = withFileMutationQueue(f.path, async () => {
      ready();
      await gate;
    });
    try {
      await started;
      const pending = f.commit();
      if (change === "owner") f.controller.abort();
      if (change === "revision") f.options.apply(f.options.getLoaded(), f.ctx);
      if (change === "disk" || change === "creation") writeFileSync(f.path, "format = 'external'\n");
      if (change === "deletion") rmSync(f.path);
      release();
      await blocker;
      if (change === "owner" || change === "revision") assert.equal(await pending, "cancel");
      else await assert.rejects(pending, /newer file was preserved/u);
      assert.deepEqual(f.history(), []);
    } finally {
      release();
      await blocker;
      f.cleanup();
    }
  });
}

test("active publication and rollback retain the reviewed identity through temporary-file staging", () => {
  for (const operation of ["save", "restore"] as const) {
    const f = fixture();
    try {
      const expected = readConfigDocumentSnapshot(f.path);
      writeFileSync(f.path, "format = 'external'\n");
      assert.throws(() => {
        if (operation === "save") atomicSaveConfigDocument(f.path, next, {}, expected);
        else atomicRestoreConfigDocument(f.path, old, {}, expected);
      }, /newer file was preserved/u);
      assert.equal(readFileSync(f.path, "utf8"), "format = 'external'\n");
      assert.equal(
        readdirSync(f.root).some((file) => file.endsWith(".tmp")),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("a failed queued transaction does not poison the next commit", async () => {
  const f = fixture();
  try {
    f.options.archive = () => {
      throw new Error("first failed");
    };
    await assert.rejects(f.commit(), /first failed/u);
    delete f.options.archive;
    assert.equal(await f.commit(), "applied");
  } finally {
    f.cleanup();
  }
});
