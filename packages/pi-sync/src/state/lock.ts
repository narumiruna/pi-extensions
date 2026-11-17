export type * from "@narumitw/pi-sync-daemon/engine/state/lock";
export {
  inspectLock,
  isLockGuardHeld,
  isStaleLock,
  lockFileExists,
  readLock,
  unlock,
  withLock,
} from "@narumitw/pi-sync-daemon/engine/state/lock";
