# Language Coach

The `teach_language` agent tool displays an original sentence, a revised sentence, and one short
language lesson above Pi's input editor. Its instructions tell the agent to call it proactively when
it finds a useful grammar or wording improvement, without waiting for a grammar error or a request
for language help. It does not need to call the tool on every turn. There is no automatic language check,
draft monitor, paste detector, or settings file.

## Use

This project-local extension is stored at `.pi/extensions/language-coach/index.ts`.
Pi discovers it after this repository is trusted. Run `/reload` in Pi from this repository,
or start a new Pi process here, to load it. It is not installed globally.
For an explicit load from the repository root, use:

```sh
pi --no-extensions -e ./.pi/extensions/language-coach/index.ts
```
Use `/lesson` to reopen the latest successful lesson on the active branch without a model request.
The command reports when the branch has no lesson. It requires interactive mode.

The tool uses `model-only` exposure. The model can call it directly; `codemode` and other tools cannot
call it. Direct calls store their results in normal session history so Pi can restore the lesson widget.
Only `teach_language` is registered as a tool. Stored results from `teach_english` restore without changing
session history. The `english-grammar` widget ID remains unchanged.

The tool supports any language. It asks the agent to choose at most one short sentence from the user's
current message and focus on that message's main language, including mixed-language messages.
Avoid pasted or quoted material, code, logs, and commands. Keep the revised sentence in its original
language and writing system; do not translate it. Explain one grammar or wording point in the main
language of the user's current message. Use one or two short sentences, familiar words, and explain
grammar terms when needed.

Useful improvements include clearer, more natural, or more concise spoken or written language,
even when the original sentence is grammatically correct. Prioritize grammar errors and substantial
wording improvements. Skip cosmetic changes, such as adding “please,” unless the user asks about tone.
Skip the tool when there is no useful improvement. Selection, language, and teaching rules are model
guidance; the tool does not verify authorship, grammar, or explanation language.

Example tool arguments:

```json
{
  "sentence": "請幫我對這個 API 進行一個更新。",
  "correction": "請幫我更新這個 API。",
  "explanation": "原句沒有文法錯誤。把「進行一個更新」改成「更新」，表達更直接，API 名稱保持不變。"
}
```

`correction` is required for each new lesson and supplies the revised sentence shown as `Suggestion`.
The agent must preserve the meaning and technical names. For a grammar error, it supplies a correction.
For an already correct sentence, it explains that the original is correct and why the suggested
wording may suit the context better. It must not present valid imperatives or style preferences as errors.
For example:

- Spoken English: `I am in agreement with you.` can become `I agree with you.` for a shorter, more natural expression.
- Written Traditional Chinese: `請對 API 文件進行更新。` can become `請更新 API 文件。` for more concise wording while keeping the technical name.

These are wording suggestions, not grammar corrections.

The original and revised sentences each have a 300-character limit; the explanation has a 240-character limit.
These limits count Unicode code points, as Pi's schema validator does.
Empty fields and fields with no visible terminal content are rejected. Joiners, variation selectors,
and combining marks are preserved within visible text. The tool does not verify authorship or grammar itself.

## Display and lifecycle

The widget hides when the user submits a new message, including a queued steering or follow-up
message. This dismissal is stored on the active branch and survives startup, reload, resume, and tree
navigation. A successful call for a newer processed message can show the widget again. `/lesson`
explicitly reopens the latest successful stored lesson, including one saved without automatic display.
The command's visibility choice also survives reload until the next submission or current lesson.
Hiding or reopening a lesson does not rewrite stored lesson fields or change other widgets.

Automatic display requires no pending user messages and a tool call whose owning user message follows
the latest submission marker. The delivered prompt text must match the submitted text's SHA-256 hash.
These checks prevent older results from reopening the widget during queued work, before enqueue, or
after a queue is cleared. A result stored after a later submission cannot undo that dismissal on reload.
Suppressed results remain in normal tool history and are available through `/lesson` or tool expansion.

This is conservative input matching, not a stable input-to-message ID supplied by Pi. Prompt templates,
skill expansion, and other input transformations can change the delivered text. Their lessons are
saved without automatic display when the text does not match. Identical prompt text cannot uniquely
identify separate submissions. Extension-injected input does not dismiss the widget, but automatic
updates wait for all queued user messages, including extension-injected ones.

Widget and tool-result labels use English: `Original`, `Suggestion`, and `Explanation`.
A displayed lesson's collapsed tool result says `Language lesson updated.` A result saved without
automatic display says `Language lesson saved. Use /lesson to show it.`
Sentence previews use one line each; the explanation uses at most two lines. Long text has an ellipsis.
Previews remove terminal controls and normalize whitespace without changing the stored fields.
Expand the tool result in Pi to read the full lesson.
The widget does not change the editor, take focus, add shortcuts, or alter the user's message.

Pi restores the recorded visibility and lesson from tool-result `details` and visibility entries on the
active branch. Older stored lessons without visibility metadata or a revised sentence still restore.
New submissions dismiss these legacy lessons in the same way as new lessons.
Stored explanations are not translated or rewritten when the language of a new message changes.
Reload preserves both the recorded language and visibility.
A branch without a lesson has no widget. Shutdown clears only this extension's widget.
There are no background tasks, timers, or network requests to release.

The tool returns the full lesson as text in RPC, JSON, and print-mode agent runs without using terminal
UI. Input and `/lesson` do not write visibility entries outside interactive mode. The command reports
its interactive-mode requirement when a client UI is available.

## Data and model use

The main agent supplies the original sentence, revised sentence, and explanation. The tool makes no
separate model or network request and needs no additional API key. Normal agent tool turns still use model quota.
Tool arguments, result text, and `details` are part of normal Pi session history. New interactive results
also record their submission marker and automatic-display decision. Dismissal entries store a SHA-256
hash of submitted prompt text, not another copy of the prompt. `/lesson` stores a reference to the chosen
lesson entry, not another copy of the lesson. Visibility entries do not participate in model context.
No separate history file is created.

The extension registers one stable tool definition and does not rewrite prompts, conversation history,
or active tools on ordinary turns. Reloading replaces its tool description and schema; new calls use
the current language guidance and still require `correction`. Existing tool results and stored lesson
fields are not rewritten.

## Verification

Run the adjacent deterministic tests from the repository root after `npm install`:

```sh
node .pi/extensions/language-coach/index.test.mjs ./node_modules/@earendil-works/pi-coding-agent
```

The tests use Pi's Jiti resource loader, mocked widget rendering, and isolated session state. They cover
required revisions, proactive wording-suggestion guidance, current-message language guidance, English
labels and result messages, multilingual display and restoration, mixed-language examples, spoken and
written wording suggestions for correct sentences, Unicode code-point limits, invisible fields,
invalid and cancelled calls, terminal safety, legacy lesson restoration without translation, non-TUI
output, branch-local dismissal and reopening across reloads, `/lesson`, malformed visibility entries,
queued and cleared input, startup and result-persistence timing, transformed prompts, selective-guidance
rules, model-only exposure, trusted-project discovery, untrusted-project exclusion, legacy tool-name
restoration, and SDK reload.
They do not contact a model provider.
Live sentence and language selection and the quality of grammar and wording suggestions remain
dependent on the agent.
