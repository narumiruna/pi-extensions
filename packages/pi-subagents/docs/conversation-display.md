# Conversation presentation

Tool calls, results, completion messages, and child requests and responses follow Pi's global tool-output expansion state and the `app.tools.expand` binding (`Ctrl+O` by default).
The hint uses the host's configured keys and is omitted when the action is unbound or an older host does not supply key formatting.

In the conversation, collapsed tool calls show the operation, target, and a short task or message preview when applicable. Results show job state, send acknowledgement, or wait outcome instead of raw JSON. Inspection shows all state counts and up to five job rows, with failed, timed-out, and partial jobs first; additional rows and jobs no longer retained have separate counts. Expanded pending calls show full arguments. After execution, expanded results show full arguments and metadata, including in HTML exports, where Pi keeps call headers collapsed. Wait results and completion notifications render the decoded result as Markdown, with errors and limitations shown separately.

Each main-session tool sends one partial progress update when execution starts. The conversation shows its pending message until the final result or error arrives. These updates do not change the final tool payload or enter model history.

Collapsed completion notifications show the job ID and terminal state. Child messages show the source job, request ID, and whether a reply is needed or a response was received. Expanding a child message retains its full security envelope and plain-text body. Unknown or malformed stored formats use a text fallback. These renderers use only the recorded payload, do not read current job state, and do not change data sent to the model or widget preferences.

Pi owns the standard tool shell and its background. Below three terminal columns, the host shell's minimum content width and padding can exceed the viewport; renderer content remains bounded.
