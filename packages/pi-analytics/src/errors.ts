import type { ProviderErrorCategory } from "./types.js";

export function classifyProviderError(message: string | undefined): ProviderErrorCategory {
  const value = message?.toLowerCase() ?? "";
  if (/\b(enotfound|eai_again|dns|getaddrinfo)\b/u.test(value)) return "dns";
  if (/\b(etimedout|timeout|timed out)\b/u.test(value)) return "timeout";
  if (/\b(econnrefused|connection refused)\b/u.test(value)) return "connection_refused";
  if (/\b(econnreset|connection reset|socket hang up)\b/u.test(value)) {
    return "connection_reset";
  }
  if (/\b(tls|ssl|certificate|cert_|handshake)\b/u.test(value)) return "tls";
  if (/\b(fetch failed|network|socket|connection|transport)\b/u.test(value)) {
    return "network_other";
  }
  return "provider_other";
}
