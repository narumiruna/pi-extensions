# Publication registry diagnostics

The coordinated publication script reports failed registry checks with a `[registry]` prefix. Each report identifies the package and version, operation, attempt, exit code, npm error code when available, and whether execution retries or stops. It includes bounded, sanitized npm stdout and stderr. A subprocess exception reports its reason instead of an exit code.

The operations are `query version`, `query tarball URL`, and `download tarball`. Cancellation during a retry delay uses `retry wait`. A version-query E404 means the version is absent and publication can continue. Readiness failures retry up to six times with the existing two-second delay; E401, E403, and ENEEDAUTH stop immediately. Parsing, artifact validation, subprocess exceptions, and cancellation still stop without readiness retries.

An exhausted readiness check retains the last failed operation and npm details in the final error. Packages published before that failure remain published. An unavailable-artifact message alone does not establish whether the cause was registry propagation, network failure, or another error; use the accompanying npm details.

## Output safety

The script normalizes escaped JSON delimiters and whitespace, then removes terminal controls before redaction. Normalization is limited to eight passes; output with deeper unresolved escape nesting is omitted. It omits the rest of a diagnostic field after an HTTP URL, Authorization header, npm registry credential assignment, or common secret assignment because incomplete or multiline output has no reliable closing delimiter. It also redacts recognizable npm and GitHub tokens before truncating each field to 2,000 characters. It prefixes every output line to block modern GitHub Actions commands. It changes `##[` to `## [` after normalization and terminal-control removal because the legacy Actions parser accepts that prefix anywhere in a line. Each normalization pass consumes complete backslash runs, including runs without a valid escape suffix, to keep processing linear in input size. It does not dump environment variables, npm configuration, or command arguments. Sanitization applies only to diagnostics and does not modify subprocess input or artifact validation.

Free-form provider output can contain sensitive values in unknown formats. Do not use logs as a credential store or add raw configuration dumps to diagnose failures. Successful registry responses are not printed.

## Verification and release restriction

Deterministic tests use fake npm and git executables to cover failure attribution, retries, authentication stops, invalid responses, artifact checks, subprocess exceptions, cancellation, output safety, and cleanup. They do not publish registry packages or create real Git tags.

The repository maintainer can inspect these diagnostics in the next separately authorized publish workflow after merge. Normal release approval and existing registry authentication are prerequisites. The expected result is a failure report that identifies the operation and sanitized npm error. Live registry timing, hosted-runner behavior, and actual credential-bearing provider errors remain unverified locally. No publication, version tag, or release workflow dispatch is authorized by this diagnostic change. The missing npm output from run `40076038982`, job `120821397527`, cannot be reconstructed from its existing log.
