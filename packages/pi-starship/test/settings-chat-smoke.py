"""Run the package-directory TUI with a local provider and controlled PTY input.

Run from the repository root with uv run python packages/pi-starship/test/settings-chat-smoke.py.
The optional first argument selects an unpacked package directory.
"""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time


repository = Path(__file__).resolve().parents[3]
package = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repository / "packages/pi-starship"
fixture = repository / "packages/pi-starship/test/settings-chat-smoke-fixture.ts"
ansi = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def run(action, mode):
    with tempfile.TemporaryDirectory(prefix="starship-pty-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        agent.mkdir()
        original = "format = '$model'\n"
        active = agent / "pi-starship.toml"
        active.write_text(original)
        (agent / "settings.json").write_text(json.dumps({"enableInstallTelemetry": False, "quietStartup": True}))
        (agent / "keybindings.json").write_text(json.dumps({"app.message.followUp": "ctrl+q"}))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
        environment = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), TERM="xterm-256color", NO_COLOR="1")
        child = subprocess.Popen([
            shutil.which("pi"), "--offline", "--no-session", "--no-context-files", "--no-extensions",
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--tui-mode", mode,
            "-e", str(package), "-e", str(fixture), "--provider", "starship-smoke", "--model", "configuration-smoke",
        ], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = ""
        ready = False

        def receive():
            nonlocal output
            readable, _, _ = select.select([master], [], [], 1)
            if not readable:
                if child.poll() is not None:
                    raise AssertionError(f"Pi exited early: {child.returncode}\n{output[-8000:]}")
                return
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                raise AssertionError(f"Pi closed PTY\n{output[-8000:]}")
            # Answer terminal capability/cursor queries without a human terminal.
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            output += ansi.sub("", data.decode("utf-8", errors="replace"))

        def wait_for(text):
            nonlocal output
            # Startup has no test deadline until the extension's readiness handshake.
            deadline = time.monotonic() + 20 if ready else None
            while text not in output:
                if deadline is not None and time.monotonic() > deadline:
                    raise AssertionError(f"Timed out waiting for {text!r}\n{output[-8000:]}")
                receive()
            observed = output
            output = output[output.index(text) + len(text):]
            return observed

        def send(data):
            os.write(master, data)

        try:
            wait_for("STARSHIP_SMOKE_READY")
            ready = True
            send(b"/starship\r")
            main_frame = wait_for("Configure with agent") + wait_for("esc close")
            assert all(label in main_frame for label in ("Presets", "Profiles", "Configuration", "Restore built-in", "Help"))
            assert all(label not in main_frame for label in ("Customize footer", "Explain footer", "Modules"))
            send(b"\x1b[B" * 3 + b"\r")
            config_frame = wait_for("Source: User file") + wait_for("Reload from disk") + wait_for("ctrl+c close")
            assert all(label in config_frame for label in ("State:", "Path:", "Health:", "History"))
            assert all(label not in config_frame for label in ("Overview", "Effective configuration", "Settings document"))
            send(b"\x1b")
            wait_for("Configure with agent")
            send(b"\x1b[H\r")
            wait_for("─ pi-starship ")
            send(b"first\r")
            wait_for("SMOKE_QUEUE_WAIT")
            send(b"second\r")
            wait_for("Steering: second")
            send(b"follow\x11")
            wait_for("Follow-up: follow")
            assert active.read_text() == original
            (root / "smoke-release").write_text("ready")
            wait_for("SMOKE_FOLLOW_READY")
            assert active.read_text() == original
            record = json.loads((root / "smoke-record.json").read_text())
            assert record["skillLoaded"] and record["tools"] == ["read", "write", "edit"]
            assert record["requests"] == 4
            assert record["userMessages"] == ["first", "second", "follow"]
            assert record["executedTools"] == ["read", "write", "edit"]
            wait_for("ctrl+s to save profile")
            if action in ("save", "save-only"):
                send(b"\x13")
                wait_for("Review draft before saving")
                send(b"\r")
                wait_for("Save as a profile")
                send(b"smoke-footer\r")
                wait_for("Apply saved profile?")
                saved_profile = agent / "pi-starship/profiles/smoke-footer.toml"
                assert saved_profile.read_text() == "# smoke draft\nformat = '$model$directory'\n"
                assert active.read_text() == original
                send(b"\r" if action == "save" else b"\x1b")
            else:
                send(b"\x03")
            deadline = time.monotonic() + 20
            while Path(record["draftPath"]).exists():
                assert time.monotonic() < deadline, output[-8000:]
                receive()
            if action == "save":
                assert active.read_text() == "# smoke draft\nformat = '$model$directory'\n"
                assert len(list((agent / "pi-starship/history").glob("*.toml"))) == 1
            else:
                assert active.read_text() == original
                assert not (agent / "pi-starship/history").exists()
            if action == "discard":
                assert not (agent / "pi-starship/profiles").exists()
            else:
                assert saved_profile.read_text() == "# smoke draft\nformat = '$model$directory'\n"
            send(b"/smoke-check\r")
            child.wait(timeout=20)
            assert child.returncode == 0
            record = json.loads((root / "smoke-record.json").read_text())
            assert record["mainMessages"] == 0
            print(f"PASS {mode} {action}: steer + follow-up, loaded skill, three tools, no parent messages, no reload, cleaned draft")
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            os.close(master)


for mode in ("regular", "fullscreen"):
    run("discard", mode)
    run("save", mode)
    run("save-only", mode)
