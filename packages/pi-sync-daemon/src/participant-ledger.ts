import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { processExists, type RuntimePaths } from "./identity.js";
import {
  type ClientFacts,
  type ClientHandoff,
  MAX_MESSAGE_BYTES,
  record,
  validateFacts,
  validateHandoff,
} from "./protocol.js";

interface LedgerPeer {
  facts: ClientFacts;
  handoff?: ClientHandoff;
}

export function createParticipantLedger<T extends LedgerPeer>(
  paths: RuntimePaths,
  participants: () => Iterable<T>,
  onFailure: () => void,
) {
  const file = path.join(paths.directory, "clients.json");
  let writes = Promise.resolve();
  let published: string | undefined;
  let failed = false;

  async function write(candidate: { peer: T; facts: ClientFacts } | undefined, allowNoop: boolean) {
    const bytes = JSON.stringify({
      version: 1,
      root: paths.root,
      clients: [...participants()]
        .filter((peer) => processExists(peer.facts.pid))
        .map((peer) => ({ ...(candidate?.peer === peer ? candidate.facts : peer.facts), handoff: peer.handoff })),
    });
    if (allowNoop && !failed && bytes === published) return;
    const temporary = path.join(paths.directory, `.${randomUUID()}.clients`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, file);
      published = bytes;
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true });
    }
  }

  return {
    get failed() {
      return failed;
    },
    drain: () => writes,
    save(candidate: { peer: T; facts: ClientFacts } | undefined, allowNoop: boolean) {
      const operation = writes.then(() => write(candidate, allowNoop));
      writes = operation.catch(() => {
        failed = true;
        onFailure();
      });
      return operation;
    },
    async restore(): Promise<LedgerPeer[]> {
      try {
        const before = await fs.lstat(file);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.size > MAX_MESSAGE_BYTES ||
          (process.getuid && before.uid !== process.getuid()) ||
          (process.platform !== "win32" && before.mode & 0o077)
        )
          throw new Error("Unsafe daemon client record.");
        await using handle = await fs.open(file, "r");
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          throw new Error("Daemon client record changed while opening.");
        const data: unknown = JSON.parse(await handle.readFile("utf8"));
        if (
          !record(data) ||
          data.version !== 1 ||
          data.root !== paths.root ||
          !Array.isArray(data.clients) ||
          data.clients.length > 64
        )
          throw new Error("Invalid daemon client record; evidence retained.");
        return data.clients.map((stored: unknown) => {
          if (!record(stored)) throw new Error("Invalid stored participant.");
          const { handoff, ...facts } = stored;
          validateFacts(facts);
          if (handoff !== undefined) validateHandoff(handoff);
          return { facts, handoff };
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
