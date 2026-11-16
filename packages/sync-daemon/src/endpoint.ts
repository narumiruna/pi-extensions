import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { type DaemonPaths, privateDirectory } from "./identity.js";

/** Node/libuv unlinks its original socket pathname, even if another file replaced it. */
export function endpointOwner(server: Server, paths: DaemonPaths) {
  let created = false;
  let retired = false;
  let retained: string | undefined;
  let directoryIdentity: { dev: number; ino: number } | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  async function retire() {
    if (retired || !created || !paths.endpointDirectory) return;
    const namespace = path.dirname(paths.directory);
    await privateDirectory(namespace);
    const container = await fs.mkdtemp(
      path.join(namespace, `${path.basename(paths.directory).slice(0, 16)}-retained-`),
    );
    try {
      // Move the entry itself, including any replacement symlink, without following it.
      // Do this only after all jobs and release acknowledgements have drained.
      await fs.rename(paths.endpointDirectory, path.join(container, "entry"));
      retained = container;
      retired = true;
    } catch (error) {
      await fs.rmdir(container).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        retired = true;
        return;
      }
      // Closing here would let Node delete an unknown replacement. Keep the owner
      // alive and permit an explicit stop retry after runtime permissions are fixed.
      throw new Error(
        "Cannot retire the IPC namespace safely. Restore runtime directory permissions, then stop again; evidence retained.",
        { cause: error },
      );
    }
  }
  async function removeKnownRetiredSocket() {
    if (!retained || !directoryIdentity) return;
    const entry = path.join(retained, "entry");
    const directory = await fs.lstat(entry).catch(() => undefined);
    if (
      !directory?.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.dev !== directoryIdentity.dev ||
      directory.ino !== directoryIdentity.ino
    )
      return;
    const target = path.join(entry, "api.sock");
    const socket = await fs.lstat(target).catch(() => undefined);
    if (socket?.isSocket() && socketIdentity && socket.dev === socketIdentity.dev && socket.ino === socketIdentity.ino)
      await fs.unlink(target);
    // Never recursively remove unknown entries or follow a replacement ancestor.
    try {
      await fs.rmdir(entry);
      await fs.rmdir(retained);
      retained = undefined;
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
  }
  return {
    async listen() {
      if (paths.endpointDirectory) {
        await fs.mkdir(paths.endpointDirectory, { mode: 0o700 });
        created = true;
        directoryIdentity = await fs.lstat(paths.endpointDirectory);
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.endpoint, resolve);
      });
      if (paths.endpointDirectory) {
        const socket = await fs.lstat(paths.endpoint);
        if (!socket.isSocket() || socket.isSymbolicLink())
          throw new Error("IPC endpoint changed during bind; evidence retained.");
        socketIdentity = socket;
        // The exclusive 0700 parent is the access boundary. A pathname chmod after
        // bind could instead follow an externally substituted symlink.
      }
    },
    async close() {
      await retire();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await removeKnownRetiredSocket();
    },
    get retainedDirectory() {
      return retained;
    },
  };
}
