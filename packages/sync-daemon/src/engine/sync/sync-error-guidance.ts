import { errorMessage } from "./sync-errors.js";

/** Add recovery advice without changing backend outcome semantics or printing error causes. */
export function syncErrorGuidance(error: unknown): string {
  const detail = errorMessage(error);
  const message = detail.length > 1200 ? `${detail.slice(0, 1200)}… (details truncated)` : detail;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const status = (error as { status?: number } | undefined)?.status;
  let next: string;
  if (code === "ENOSPC") {
    next = "Free disk space for the private pi-sync settings/state directory, then retry.";
  } else if (code && ["EACCES", "EPERM", "EROFS"].includes(code)) {
    next = "Check write access to the private pi-sync settings/state directory, then retry.";
  } else if (code && ["EBUSY", "EIO", "EMFILE", "ENFILE"].includes(code)) {
    next = "Check local disk availability and other processes using the private settings file, then retry.";
  } else if (/changed while|type changed|reopen/iu.test(message)) {
    next = "Reopen the item in /sync and review its current settings before saving again.";
  } else if (
    status === 401 ||
    status === 403 ||
    /Permission denied|Authentication failed|HTTP (401|403)|failed \((401|403)\)/iu.test(message)
  ) {
    next = "Check the storage connection's credentials and remote permissions in /sync → More → Storage connections.";
  } else if (status === 404 || /HTTP 404|failed \(404\)/iu.test(message)) {
    next =
      "Verify the connection address and setup's bucket, branch, or path with your provider; this response alone does not prove which resource is missing.";
  } else if (status !== undefined && status >= 500) {
    next = "Check your storage provider's service status, then retry Check setup before syncing.";
  } else if (/timed out|timeout|request failed|resolve host|Could not resolve|ENOTFOUND|ECONNREFUSED/iu.test(message)) {
    next = "Check the server address and network connection, then run /sync doctor for the affected setup.";
  } else if (/strong ETag|If-Match|If-None-Match|precondition|conditional header/iu.test(message)) {
    next =
      "Ask your provider to check strong ETags and conditional writes, including proxy behavior, or choose compatible storage. Do not bypass these safety checks.";
  } else if (/spawn git ENOENT/iu.test(message)) {
    next = "Install Git 2.30 or newer and make sure Pi can find git on PATH, then retry.";
  } else if (/response exceeds.*byte limit/iu.test(message)) {
    next =
      "Verify the storage endpoint; the server returned an unexpectedly large response. Check your provider's logs before retrying.";
  } else if (/settings|config|already exists|duplicates|same normalized/iu.test(message)) {
    next =
      "Correct the named field or item in /sync. If the settings file is invalid, repair it before retrying; do not replace it with defaults.";
  } else {
    next = "Open /sync → More → Check setup and review the reported checks before retrying.";
  }
  return `${message}\n${next}`;
}
