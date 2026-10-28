"""Exercise the built package in an isolated Unix PTY without a live model call."""

import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
ARTIFACTS = pathlib.Path(tempfile.mkdtemp(prefix="starship-native-pty-"))
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def create_fixture():
    fixture = ARTIFACTS / "fixture.ts"
    ai = json.dumps(str(ROOT / "node_modules/@earendil-works/pi-ai/dist/index.js"))
    tui = json.dumps(str(ROOT / "node_modules/@earendil-works/pi-tui/dist/index.js"))
    fixture.write_text(
        "import { writeFileSync } from 'node:fs';\n"
        f"import {{ createAssistantMessageEventStream }} from {ai};\n"
        f"import {{ TuiMainScreen, TuiAltScreen }} from {tui};\n"
        """
export default function(pi) {
  // Observe the public start boundary; exiting alt-screen is earlier than
  // terminal restoration, so it is not a safe handshake for the next input.
  for (const Type of [TuiMainScreen, TuiAltScreen]) {
    const start = Type.prototype.start;
    Type.prototype.start = function() {
      start.call(this);
      writeFileSync('terminal-start', 'ok');
    };
  }
  pi.on('session_start', (_event, ctx) => {
    let step = 0;
    ctx.modelRegistry.streamSimple = (_model, request) => {
      const stream = createAssistantMessageEventStream();
      const prompt = request.messages.find((item) => item.role === 'system')?.content;
      const path = typeof prompt === 'string' ? /Draft path: ([^\\n]+)/.exec(prompt)?.[1] : undefined;
      if (!path) throw new Error('Missing isolated draft path');
      const calls = [
        {type: 'toolCall', id: 'smoke-write', name: 'write', arguments: {path, content: "format = '$directory'\\n"}},
        {type: 'toolCall', id: 'smoke-edit', name: 'edit', arguments: {path, edits: [{oldText: '$directory', newText: '$model'}]}},
        {type: 'toolCall', id: 'smoke-read', name: 'read', arguments: {path}},
      ];
      const call = calls[step++];
      const message = {
        role: 'assistant',
        content: call ? [call] : [{type: 'text', text: Array.from({length: 120}, (_, i) => `pty-row-${i}`).join('\\n')}],
        api: 'openai-completions', provider: 'openai', model: 'gpt-4o',
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: call ? 'toolUse' : 'stop', timestamp: 0,
      };
      stream.push({type: 'done', reason: message.stopReason, message});
      return stream;
    };
    writeFileSync('ready', 'ready');
  });
  pi.registerCommand('smoke-parent', {
    description: 'Verify restored parent',
    handler: async () => { writeFileSync('parent-input', 'ok'); },
  });
  pi.on('session_shutdown', () => { writeFileSync('shutdown', 'ok'); });
}
""",
        encoding="utf8",
    )
    return fixture


def smoke(mode, fixture):
    work = ARTIFACTS / mode
    work.mkdir()
    agent = work / "agent"
    agent.mkdir()
    (agent / "settings.json").write_text(
        json.dumps({"tuiMode": mode, "quietStartup": True}), encoding="utf8"
    )
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    env = dict(
        os.environ,
        PI_CODING_AGENT_DIR=str(agent),
        TERM="xterm-256color",
        NO_COLOR="1",
    )
    env.pop("PI_TUI_WRITE_LOG", None)
    child = subprocess.Popen(
        [
            "node",
            str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
            "--no-extensions",
            "-e",
            str(ROOT / "packages/pi-starship"),
            "-e",
            str(fixture),
            "--provider",
            "openai",
            "--model",
            "gpt-4o",
            "--no-session",
            "--no-skills",
            "--no-prompt-templates",
            "--no-tools",
        ],
        cwd=work,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()

    def text():
        return ANSI.sub("", output.decode(errors="replace"))

    def until(predicate, label, deadline):
        while not predicate():
            if child.poll() is not None:
                raise RuntimeError(f"{mode}: exited before {label}: {text()[-4000:]}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"{mode}: timeout {label}: {text()[-4000:]}")
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    if child.poll() is None:
                        raise

    try:
        # The caller bounds startup. Start the interaction deadline only after
        # session_start signals readiness, not when the subprocess is spawned.
        until(lambda: (work / "ready").exists(), "startup readiness", float("inf"))
        deadline = time.monotonic() + 20
        output.clear()
        os.write(master, b"/starship\r")
        until(lambda: "Configure with agent" in text(), "Starship menu", deadline)
        output.clear()
        os.write(master, b"\r")
        until(lambda: "to save profile" in text(), "fullscreen chat", deadline)
        output.clear()
        os.write(master, b"Generate history\r")
        until(lambda: "pty-row-119" in text(), "deterministic response", deadline)
        output.clear()
        os.write(master, b"\x1b[1;5H")
        until(lambda: "+1 format" in text(), "native completed edit diff", deadline)
        output.clear()
        os.write(master, b"\x1b[1;5F")
        until(lambda: "pty-row-119" in text(), "return to history end", deadline)
        output.clear()
        os.write(master, b"\x1b[5~")
        until(lambda: "pty-row-" in text(), "native page-up redraw", deadline)
        assert "pty-row-119" not in text(), text()[-1000:]
        output.clear()
        os.write(master, b"\x1b[<64;2;2M")
        until(lambda: "pty-row-" in text(), "native wheel redraw", deadline)
        (work / "terminal-start").unlink(missing_ok=True)
        output.clear()
        os.write(master, b"\x03")
        until(lambda: b"\x1b[?1049l" in output, "child terminal exit", deadline)
        until(
            lambda: (work / "terminal-start").exists(),
            "parent terminal restart handshake",
            deadline,
        )
        os.write(master, b"/smoke-parent\r")
        until(lambda: (work / "parent-input").exists(), "first restored parent command", deadline)
        os.write(master, b"\x04")
        until(lambda: (work / "shutdown").exists(), "graceful shutdown", deadline)
        child.wait(timeout=5)
        assert child.returncode == 0, child.returncode
        print(json.dumps({"mode": mode, "status": "passed", "provider_requests": 0}))
    finally:
        (work / "transcript.txt").write_bytes(output)
        try:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        finally:
            os.close(master)


if __name__ == "__main__":
    # A caller timeout must still release the isolated child process and PTY.
    def terminate(_signal, _frame):
        raise SystemExit("Smoke terminated by caller")

    signal.signal(signal.SIGTERM, terminate)
    fixture = create_fixture()
    try:
        for mode in ["regular", "fullscreen"]:
            smoke(mode, fixture)
    finally:
        print(f"artifacts={ARTIFACTS}")
