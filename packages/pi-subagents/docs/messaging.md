# Pi Subagents messaging and lifecycle

Main and child processes have separate `subagent_send` definitions. The main agent starts a request with an active job ID as `recipient` and answers a child request with its `requestId`. A child omits `requestId` to ask the main agent a question and provides it to answer a pending main-agent request. See [Tools](./tools.md) for the parameter schemas.

## Delivery and waiting

A main-originated request to a queued job waits for the child RPC prompt to be accepted, then uses Pi steering to reach the running child. After RPC accepts steering, the runtime interrupts active child response waits without consuming their original requests. The child may retry `subagent_wait` for a response it still needs.

Caller cancellation before RPC delivery starts rolls the request back. Once delivery starts, cancellation stops only the caller's wait: the request may still arrive and remains answerable until delivery fails or the job terminates. A wait timeout likewise stops only that wait, not the job or the underlying message request.

A child response arrives asynchronously in the main session and interrupts the next active main-agent `subagent_wait`, including when the response arrived immediately before the wait started. The first accepted response wins; repeated responses acknowledge the existing response without replacing it.

Each job may have up to four unresolved or answered-but-not-consumed requests across both directions. Requests and responses are limited to 48 KiB and 1,992 lines so their envelopes fit Pi's model-text bounds. Terminal jobs, unknown requests, cross-job responses, responses from the request originator, and stale session credentials throw. Successful sends and responses return `{ requestId, accepted, duplicate }`.

## Job lifecycle

A job starts `queued`, becomes `running`, and reaches exactly one terminal state: `completed`, `partial`, `failed`, `timed_out`, or `cancelled`. Job execution timeouts start after Pi accepts the RPC prompt. The runtime retains up to 32 recent terminal records for up to 24 hours in the current extension session; inspection reports removed records through `omitted.jobs`.

Cancelling or terminalizing a job revokes its communication token and rejects pending child waits before stale output can replace the terminal state. Session replacement and shutdown cancel active work, suppress stale completion delivery, revoke credentials, close sockets, and stop the broker. An asynchronous job completion does not wake an otherwise idle main-agent model turn.

The session starts one loopback TCP broker on `127.0.0.1` with an ephemeral port. Each job receives a random token bound to its job identity and session generation. The parent passes credentials through a private inherited pipe rather than the child's initial environment or command line. Child broker calls use request-scoped connections; response waits use abortable long polling.

For authorization boundaries and credential exposure, see [Security and privacy](../README.md#-security-and-privacy).
