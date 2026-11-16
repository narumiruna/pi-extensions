export type * from "@narumitw/sync-daemon/engine/state/lock";
export {
  inspectLock,
  isLockGuardHeld,
  isStaleLock,
  lockFileExists,
  readLock,
  unlock,
  withLock,
} from "@narumitw/sync-daemon/engine/state/lock";
