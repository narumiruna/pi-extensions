export type * from "sync-daemon/engine/state/lock";
export {
  inspectLock,
  isLockGuardHeld,
  isStaleLock,
  lockFileExists,
  readLock,
  unlock,
  withLock,
} from "sync-daemon/engine/state/lock";
