export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

export function combineSignals(primary: AbortSignal, secondary?: AbortSignal) {
  return secondary ? AbortSignal.any([primary, secondary]) : primary;
}
