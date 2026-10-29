"""Run with uv run python packages/pi-btw/test/fullscreen-handoff-smoke.py.

Use the existing built package, a local provider, and an isolated Unix PTY.
Optional --main-submission and --opened-while-streaming add split-pane routes;
the default six-case handoff matrix always runs unchanged.
Keep all runtime fixtures and transcripts outside the repository, also on failure.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = Path(tempfile.mkdtemp(prefix="btw-fullscreen-handoff-"))
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
QUESTION = "BTW_PTY_ONLY_QUESTION"


def fixture():
    path = ARTIFACTS / "fixture.ts"
    imports = "import {existsSync, readFileSync, renameSync, watch, writeFileSync} from 'node:fs';\n"
    for package, names in [
        ("pi-ai", "createAssistantMessageEventStream"),
        ("pi-tui", "TuiMainScreen, TuiAltScreen"),
    ]:
        module = ROOT / f"node_modules/@earendil-works/{package}/dist/index.js"
        imports += f"import {{{names}}} from {json.dumps(str(module))};\n"
    path.write_text(imports + """
export default function(pi) {
  const config = JSON.parse(readFileSync('scenario.json', 'utf8'));
  const record = {requests: 0, baseline: -1, mainMessages: -1, userMessages: [], errors: [],
    calls: [], settled: [], inputs: [], branch: []};
  const save = () => {
    writeFileSync('record.tmp', JSON.stringify(record));
    renameSync('record.tmp', 'record.json');
  };
  const messages = ctx => ctx.sessionManager.getBranch().filter(e => e.type === 'message').map(e => e.message);
  const count = ctx => messages(ctx).length;
  const content = m => typeof m.content === 'string' ? m.content :
    m.content.filter(p => p.type === 'text').map(p => p.text).join('');
  const pending = new Set();
  const gate = signal => new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      watcher.close(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      pending.delete(abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('Main gate aborted'));
    const check = () => { if (existsSync('release-main')) finish(); };
    const watcher = watch('.', check);
    const timer = setTimeout(() => finish(new Error('Main gate timed out')), 20000);
    pending.add(abort);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort(); else check();
  });
  let starts = 0;
  for (const Type of [TuiMainScreen, TuiAltScreen]) {
    const start = Type.prototype.start;
    Type.prototype.start = function(...args) {
      const result = start.apply(this, args);
      writeFileSync('terminal-start', String(++starts));
      return result;
    };
  }
  pi.registerProvider('btw-local-smoke', {
    api: 'btw-local-smoke', apiKey: 'local-only', baseUrl: 'http://unused.invalid',
    models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 4096,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
    streamSimple(model, context, options) {
      record.requests++;
      const users = context.messages.filter(m => m.role === 'user').map(content);
      record.userMessages = users;
      const side = users.at(-1)?.includes('<side_question>\\nBTW_PTY_ONLY_QUESTION\\n</side_question>');
      const kind = side ? 'side' : users.at(-1) === config.seed ? 'seed' :
        users.at(-1) === config.steer ? 'steer' : users.at(-1) === config.main ? 'main' : 'unexpected';
      const expected = config.streaming ? ['seed', 'side', 'steer', 'main'] :
        config.main ? ['side', 'main'] : ['side'];
      const call = {kind, users, completed: false};
      record.calls.push(call);
      const mainUsers = kind === 'seed' ? [config.seed] : kind === 'steer' ? [config.seed, config.steer] :
        config.streaming ? [config.seed, config.steer, config.main] : [config.main];
      // BTW quotes the captured main branch inside one user message; it must not
      // import later main completion, steering, or the new Main prompt implicitly.
      const sidePrompt = ['Answer this side question without modifying the main conversation.', '',
        '<side_question>', 'BTW_PTY_ONLY_QUESTION', '</side_question>', '', '<conversation_context>',
        config.streaming ? `User: ${config.seed}` : 'No prior conversation context was available.',
        '</conversation_context>'].join('\\n');
      const cleanSide = side && JSON.stringify(users) === JSON.stringify([sidePrompt]);
      if (kind !== expected[record.calls.length - 1] ||
          (side ? !cleanSide : JSON.stringify(users) !== JSON.stringify(mainUsers)) ||
          (!side && context.messages.some(m => content(m).includes('btw-pty-row-')))) {
        record.errors.push('Unexpected provider request or side/main contamination');
        save();
        throw new Error(record.errors.at(-1));
      }
      save();
      const answer = side ? Array.from({length: 100}, (_, i) => `btw-pty-row-${String(i).padStart(3, '0')}`).join('\\n') :
        `LOCAL_COMPLETED_${kind.toUpperCase()}`;
      const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{type: 'text', text: answer}],
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: 'stop', timestamp: 0};
      const stream = createAssistantMessageEventStream();
      const complete = () => {
        call.completed = true;
        save();
        stream.push({type: 'done', reason: 'stop', message});
      };
      if (kind === 'seed') {
        stream.push({type: 'start', partial: {...message, content: []}});
        writeFileSync('main-active', 'ready');
        gate(options?.signal).then(complete, error => {
          record.errors.push(error.message); save();
          stream.push({type: 'error', reason: 'aborted', error: {...message,
            stopReason: 'aborted', errorMessage: error.message}});
        });
      } else complete();
      return stream;
    },
  });
  pi.on('session_start', (_event, ctx) => {
    record.baseline = count(ctx);
    save();
    writeFileSync('ready', 'ready');
  });
  pi.on('input', event => {
    record.inputs.push({text: event.text, streamingBehavior: event.streamingBehavior});
    save();
  });
  // agent_end is not idle: queued steering or retries can still start another run.
  pi.on('agent_settled', (_event, ctx) => {
    record.settled.push(messages(ctx).map(m => ({role: m.role, text: content(m)})));
    save();
  });
  pi.registerCommand('smoke-parent', {
    description: 'Record restored input and stop the smoke',
    handler: async (_args, ctx) => {
      record.mainMessages = count(ctx);
      record.branch = messages(ctx).map(m => ({role: m.role, text: content(m)}));
      record.editor = ctx.ui.getEditorText();
      save();
      writeFileSync('parent-input', 'ok');
      ctx.shutdown();
    },
  });
  pi.on('session_shutdown', () => {
    for (const abort of [...pending]) abort();
    save(); writeFileSync('shutdown', 'ok');
  });
}
""", encoding="utf8")
    return path


def smoke(mode, layout, extension, scenario="default", opening="direct"):
    suffix = "" if scenario == "default" else f"-{scenario}-{opening}"
    work = ARTIFACTS / f"{mode}-{layout}{suffix}"
    work.mkdir()
    streaming = scenario == "opened-while-streaming"
    main = f"MAIN_PTY_ONLY_{work.name}" if scenario != "default" else None
    seed = f"GATED_PTY_ONLY_{work.name}" if streaming else None
    steer = f"STEER_PTY_ONLY_{work.name}" if streaming else None
    (work / "scenario.json").write_text(json.dumps({
        "main": main, "seed": seed, "steer": steer, "streaming": streaming,
    }))
    agent = work / "agent"
    agent.mkdir()
    settings = agent / "pi-btw.json"
    settings.write_text(json.dumps({"layout": layout, "fullscreenCopyOnSelect": False}))
    original_settings = settings.read_bytes()
    (agent / "settings.json").write_text(json.dumps({"tuiMode": mode, "quietStartup": True}))
    # Use a documented non-default binding, independent of WSL/macOS defaults.
    (agent / "keybindings.json").write_text(json.dumps({"tui.altScreen.search": "ctrl+f"}))
    master, slave = pty.openpty()
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), TERM="xterm-256color", NO_COLOR="1")
    env.pop("PI_TUI_WRITE_LOG", None)
    command = ["node", str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
               "-e", str(ROOT / "packages/pi-btw"), "-e", str(extension),
               "--provider", "btw-local-smoke", "--model", "fixture", "--offline", "--no-approve",
               "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates",
               "--no-themes", "--no-tools", "--no-session"]
    child = None
    output = bytearray()
    mark = 0
    deadline = time.monotonic() + 60  # Separate, bounded startup allowance.

    def text():
        # Do not send the next input while a native frame is only partly read.
        end = output.rfind(b"\x1b[?2026l")
        return ANSI.sub("", output[mark:end].decode(errors="replace")) if end >= mark else ""

    def until(predicate, label):
        while not predicate():
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError(f"{work.name}: failed {label}: {text()[-2500:]}")
            if select.select([master], [], [], 0.02)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    if child.poll() is None:
                        raise

    def send(data):
        nonlocal mark
        mark = len(output)
        os.write(master, data)

    def rows():
        return [int(n) for n in re.findall(r"btw-pty-row-(\d{3})", text())]

    def record():
        return json.loads((work / "record.json").read_text())

    def completed(kind):
        return any(call["kind"] == kind and call["completed"] for call in record()["calls"])

    def settled(answer):
        return any(any(m["role"] == "assistant" and m["text"] == answer for m in branch)
                   for branch in record()["settled"])

    def starts():
        path = work / "terminal-start"
        return int(path.read_text() or "0") if path.exists() else 0

    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        child = subprocess.Popen(command, cwd=work, env=env, stdin=slave, stdout=slave,
                                 stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        # Interaction timing starts after the child readiness handshake only.
        until(lambda: (work / "ready").exists(), "session readiness")
        deadline = time.monotonic() + 40
        if streaming:
            send(f"{seed}\r".encode())
            until(lambda: (work / "main-active").exists(), "gated main provider readiness")
            assert not completed("seed") and not record()["settled"], record()
        if opening == "manager":
            send(b"/btw\r")
            until(lambda: "Start side thread" in text(), "BTW manager")
            send(b"\r")  # Select the first manager action, not a direct question route.
            until(lambda: "BTW focus" in text(), "empty side-thread composer")
            send(f"{QUESTION}\r".encode())
        else:
            send(f"/btw {QUESTION}\r".encode())
        until(lambda: "btw-pty-row-099" in text(), "last answer row")
        assert starts() >= 2, "No dedicated terminal start"
        if main:
            dedicated_starts = starts()
            send(b"\x1b[17~")  # F6, the first available default pane switch.
            until(lambda: "Main focus" in text(), "Main pane focus")
            if streaming:
                assert not completed("seed"), "Gated main completed before BTW opened"
                send(f"{steer}\r".encode())
                until(lambda: any(item["text"] == steer and item.get("streamingBehavior") == "steer"
                                  for item in record()["inputs"]), "native main steering acceptance")
                assert not completed("seed"), "Steering was not submitted during the main run"
                (work / "release-main").write_text("release")
                until(lambda: completed("seed") and completed("steer") and
                      settled("LOCAL_COMPLETED_STEER"), "gated main and steering agent_settled")
            send(f"{main}\r".encode())
            until(lambda: completed("main") and settled("LOCAL_COMPLETED_MAIN"),
                  "new main provider completion and agent_settled while BTW remains open")
            assert starts() == dedicated_starts, "BTW closed before main completion"
            send(b"\x1b[17~")
            until(lambda: "BTW focus" in text(), "side focus after main settlement")
        send(b"\x1b[5~")
        until(lambda: bool(rows()), "native PageUp redraw")
        assert 99 not in rows() and max(rows()) < 99, "PageUp did not move away from end"
        page_rows = rows()
        # Wheel coordinates must be inside the BTW pane in both split layouts.
        x = 110 if layout == "right-pane" else 10
        send(f"\x1b[<64;{x};5M".encode())
        until(lambda: bool(rows()), "native wheel redraw")
        assert 99 not in rows() and min(rows()) < min(page_rows), "Wheel did not scroll earlier"
        send(b"\x06")  # Configured native search binding.
        until(lambda: "Shift+Enter" in text(), "nested search overlay")
        send(b"\x1b")
        until(lambda: bool(rows()), "search cancellation redraw")
        assert "Shift+Enter" not in text(), "Search did not close"
        # Reopen search: hard cancellation must close the ROOT under nested focus.
        send(b"\x06")
        until(lambda: "Shift+Enter" in text(), "reopened nested search")
        before = starts()
        send(b"\x03")
        until(lambda: starts() > before, "parent terminal start handshake")
        # This write is separate from Ctrl+C and occurs only after restoration.
        send(b"RESTORED_PRINTABLE")
        until(lambda: "RESTORED_PRINTABLE" in text(), "first separate parent printable")
        send(b"\x15/smoke-parent\r")  # Clear the observed draft, then execute locally.
        until(lambda: (work / "parent-input").exists(), "parent slash command")
        until(lambda: (work / "shutdown").exists(), "orderly session shutdown")
        child.wait(timeout=5)
        assert child.returncode == 0, child.returncode
        final = record()
        kinds = ["seed", "side", "steer", "main"] if streaming else ["side", "main"] if main else ["side"]
        assert final["requests"] == len(kinds) and not final["errors"], final
        assert [call["kind"] for call in final["calls"]] == kinds, final
        assert all(call["completed"] for call in final["calls"]), final
        # Pi persists one structured system message when the first main run starts.
        expected_branch = [{"role": "system", "text": ""}] if main else []
        for prompt, answer in ([(seed, "SEED"), (steer, "STEER"), (main, "MAIN")] if streaming else
                               [(main, "MAIN")] if main else []):
            expected_branch.extend([{"role": "user", "text": prompt},
                                    {"role": "assistant", "text": f"LOCAL_COMPLETED_{answer}"}])
        assert final["baseline"] == 0 and final["mainMessages"] == len(expected_branch), final
        assert final["branch"] == expected_branch, final
        assert settings.read_bytes() == original_settings, "BTW settings changed"
        result = {"parent": mode, "layout": layout, "status": "passed", "provider_requests": len(kinds),
                  "proofs": ["answer", "PageUp", "wheel", "search-close", "nested-root-Ctrl+C",
                             "parent-start", "separate-printable", "parent-command", "shutdown",
                             "isolated-main-messages" if main else "zero-main-messages", "unchanged-settings"]}
        if main:
            result.update(scenario=scenario, opening=opening)
            result["proofs"].extend(["main-focus", "main-provider-completion", "agent_settled-before-close"])
            if streaming:
                result["proofs"].extend(["opened-during-main", "native-steering", "gated-agent_settled"])
        (work / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    finally:
        try:
            (work / "transcript.bin").write_bytes(output)
            (work / "transcript.txt").write_text(ANSI.sub("", output.decode(errors="replace")))
        finally:
            try:
                if child is not None:
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=3)
            finally:
                os.close(master)
                if slave is not None:
                    os.close(slave)


if __name__ == "__main__":
    def terminate(_signal, _frame):
        raise SystemExit("Smoke terminated by caller")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-submission", action="store_true",
                        help="Also submit an idle Main prompt in each split, through direct and manager openings")
    parser.add_argument("--opened-while-streaming", action="store_true",
                        help="Also open each split during a gated main run, steer, settle, and submit again")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, terminate)
    try:
        extension = fixture()
        for mode in ["regular", "fullscreen"]:
            for layout in ["fullscreen", "left-pane", "right-pane"]:
                smoke(mode, layout, extension)
            for scenario, enabled in [("main-submission", args.main_submission),
                                      ("opened-while-streaming", args.opened_while_streaming)]:
                if enabled:
                    for layout in ["left-pane", "right-pane"]:
                        for opening in ["direct", "manager"]:
                            smoke(mode, layout, extension, scenario, opening)
        print("Limits: no physical IME, clipboard, platform, parent viewport, or draft-preservation proof; "
              "regular split parents have no native main viewport semantics.")
    finally:
        print(f"artifacts={ARTIFACTS}", flush=True)
