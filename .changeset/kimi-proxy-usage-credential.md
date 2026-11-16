---
"@narumitw/pi-usage": minor
---

Support a dedicated official Kimi Coding usage credential for the currently selected proxy model through the optional user-only `kimiCodingUsageApiKey` setting and masked `/usage` Settings UI. Keep `PI_USAGE_KIMI_CODING_API_KEY` compatibility: nonblank environment values override the file, whitespace-only values fall back to it, and malformed nonblank values fail closed. Saves apply immediately, protect the plaintext file with `0600` POSIX atomic writes, and never display the existing key. Usage stays on the fixed official endpoint without reading proxy credentials or changing inference; official direct selections ignore both sources and continue using Pi auth.
