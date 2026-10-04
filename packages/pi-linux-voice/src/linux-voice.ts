import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type VoiceContext = {
  hasUI: boolean;
  signal?: AbortSignal;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    pasteToEditor(text: string): void;
  };
};

/** Linux voice input using ffmpeg and an OpenAI-compatible transcription API. */
export default function (pi: ExtensionAPI) {
  let recorder: ChildProcess | undefined;
  let recordingFile: string | undefined;
  let recordingDir: string | undefined;
  let stopping = false;

  const notify = (ctx: VoiceContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  async function transcribe(file: string, ctx: VoiceContext): Promise<string> {
    // Groq free-tier limits vary by model and account. Daily limits reset at
    // 00:00 UTC; per-minute limits recover after their one-minute window.
    // Check https://console.groq.com/settings/limits for current values.
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("Set OPENAI_API_KEY or GROQ_API_KEY before using voice input");
    }

    const isGroq = Boolean(process.env.GROQ_API_KEY) && !process.env.OPENAI_API_KEY;
    const endpoint =
      process.env.PI_VOICE_TRANSCRIBE_URL ??
      (isGroq
        ? "https://api.groq.com/openai/v1/audio/transcriptions"
        : "https://api.openai.com/v1/audio/transcriptions");
    const model =
      process.env.PI_VOICE_TRANSCRIBE_MODEL ?? (isGroq ? "whisper-large-v3-turbo" : "gpt-4o-mini-transcribe");

    const audio = await readFile(file);
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "voice.wav");
    form.append("model", model);
    form.append("response_format", "json");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctx.signal ?? undefined,
    });

    if (!response.ok) {
      throw new Error(`Transcription failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }

    const result = (await response.json()) as { text?: string };
    if (!result.text?.trim()) throw new Error("Transcription returned no text");
    return result.text.trim();
  }

  async function stop(ctx: VoiceContext) {
    if (!recorder || stopping) return;
    stopping = true;
    const child = recorder;
    recorder = undefined;
    child.stdin?.write("q");
    child.stdin?.end();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGINT");
        resolve();
      }, 3000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const file = recordingFile;
    const dir = recordingDir;
    recordingFile = undefined;
    recordingDir = undefined;
    if (!file) {
      stopping = false;
      return;
    }

    try {
      notify(ctx, "Transcribing…");
      const text = await transcribe(file, ctx);
      ctx.ui.pasteToEditor(`${text} `);
      notify(ctx, "Voice text inserted");
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
      stopping = false;
    }
  }

  async function start(ctx: VoiceContext) {
    if (recorder) return;
    if (!process.platform.startsWith("linux")) {
      notify(ctx, "pi-linux-voice is intended for Linux", "warning");
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "pi-voice-"));
    const file = join(dir, `${randomUUID()}.wav`);
    const useAlsa = process.env.PI_VOICE_INPUT === "alsa";
    const device = process.env.PI_VOICE_DEVICE ?? "default";
    const inputArgs = useAlsa ? ["-f", "alsa", "-i", device] : ["-f", "pulse", "-i", device];
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", ...inputArgs, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", file],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    recorder = child;
    recordingFile = file;
    recordingDir = dir;
    stopping = false;

    child.once("error", (error) => {
      if (recorder !== child) return;
      recorder = undefined;
      recordingFile = undefined;
      recordingDir = undefined;
      void rm(dir, { recursive: true, force: true });
      notify(ctx, `Could not start microphone: ${error.message}`, "error");
      stopping = false;
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (process.env.PI_VOICE_DEBUG) process.stderr.write(data);
    });

    notify(ctx, "Recording… press Ctrl+Space again to stop");
  }

  async function toggle(ctx: VoiceContext) {
    if (recorder) await stop(ctx);
    else await start(ctx);
  }

  pi.registerShortcut(Key.ctrl("space"), {
    description: "Toggle Linux voice recording",
    handler: toggle,
  });

  pi.registerCommand("voice", {
    description: "Record from the Linux microphone and insert a transcription",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "start" || (!command && !recorder)) return start(ctx);
      if (command === "stop" || (!command && recorder)) return stop(ctx);
      if (command === "status") {
        notify(ctx, recorder ? "Recording" : "Ready");
        return;
      }
      notify(ctx, "Usage: /voice [start|stop|status]", "warning");
    },
  });

  pi.on("session_shutdown", async () => {
    if (recorder) {
      recorder.kill("SIGINT");
      recorder = undefined;
    }
  });
}
