"""Run with uv run python packages/pi-btw/test/fullscreen-handoff-smoke.py.

Use the existing built package, a local provider, and an isolated Unix PTY.
Keep all runtime fixtures and transcripts outside the repository, also on failure.
"""

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
    imports = "import {writeFileSync} from 'node:fs';\n"
    for package, names in [
        ("pi-ai", "createAssistantMessageEventStream"),
        ("pi-tui", "TuiMainScreen, TuiAltScreen"),
    ]:
        module = ROOT / f"node_modules/@earendil-works/{package}/dist/index.js"
        imports += f"import {{{names}}} from {json.dumps(str(module))};\n"
    path.write_text(imports + """
export default function(pi) {
  const record = {requests: 0, baseline: -1, mainMessages: -1, userMessages: [], errors: []};
  const save = () => writeFileSync('record.json', JSON.stringify(record));
  const count = ctx => ctx.sessionManager.getBranch().filter(e => e.type === 'message').length;
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
    streamSimple(model, context) {
      record.requests++;
      record.userMessages = context.messages.filter(m => m.role === 'user').map(m =>
        typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join(''));
      if (record.requests !== 1 || record.userMessages.length !== 1 ||
          !record.userMessages[0].includes('<side_question>\\nBTW_PTY_ONLY_QUESTION\\n</side_question>')) {
        record.errors.push('Unexpected provider request');
        save();
        throw new Error('Unexpected provider request');
      }
      save();
      const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{type: 'text', text: Array.from({length: 100}, (_, i) => `btw-pty-row-${String(i).padStart(3, '0')}`).join('\\n')}],
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: 'stop', timestamp: 0};
      const stream = createAssistantMessageEventStream();
      stream.push({type: 'done', reason: 'stop', message});
      return stream;
    },
  });
  pi.on('session_start', (_event, ctx) => {
    record.baseline = count(ctx);
    save();
    writeFileSync('ready', 'ready');
  });
  pi.registerCommand('smoke-parent', {
    description: 'Record restored input and stop the smoke',
    handler: async (_args, ctx) => {
      record.mainMessages = count(ctx);
      record.editor = ctx.ui.getEditorText();
      save();
      writeFileSync('parent-input', 'ok');
      ctx.shutdown();
    },
  });
  pi.on('session_shutdown', () => { save(); writeFileSync('shutdown', 'ok'); });
}
""", encoding="utf8")
    return path


def smoke(mode, layout, extension):
    work = ARTIFACTS / f"{mode}-{layout}"
    work.mkdir()
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
    deadline = float("inf")

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

    def starts():
        path = work / "terminal-start"
        return int(path.read_text() or "0") if path.exists() else 0

    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        child = subprocess.Popen(command, cwd=work, env=env, stdin=slave, stdout=slave,
                                 stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        # The caller bounds startup. Interaction timing starts after READY only.
        until(lambda: (work / "ready").exists(), "session readiness")
        deadline = time.monotonic() + 25
        send(f"/btw {QUESTION}\r".encode())
        until(lambda: "btw-pty-row-099" in text(), "last answer row")
        assert starts() >= 2, "No dedicated terminal start"
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
        record = json.loads((work / "record.json").read_text())
        assert record["requests"] == 1 and not record["errors"], record
        assert record["baseline"] == record["mainMessages"] == 0, record
        assert settings.read_bytes() == original_settings, "BTW settings changed"
        result = {"parent": mode, "layout": layout, "status": "passed", "provider_requests": 1,
                  "proofs": ["answer", "PageUp", "wheel", "search-close", "nested-root-Ctrl+C",
                             "parent-start", "separate-printable", "parent-command", "shutdown",
                             "zero-main-messages", "unchanged-settings"]}
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

    signal.signal(signal.SIGTERM, terminate)
    try:
        extension = fixture()
        for mode in ["regular", "fullscreen"]:
            for layout in ["fullscreen", "left-pane", "right-pane"]:
                smoke(mode, layout, extension)
        print("Limits: no physical IME, clipboard, platform, parent viewport, or draft-preservation proof; "
              "regular split parents have no native main viewport semantics.")
    finally:
        print(f"artifacts={ARTIFACTS}", flush=True)
