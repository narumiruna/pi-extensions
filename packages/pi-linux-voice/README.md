# 🎙️ pi-linux-voice — Voice Input for Pi on Linux

[![npm](https://img.shields.io/npm/v/@narumitw/pi-linux-voice)](https://www.npmjs.com/package/@narumitw/pi-linux-voice) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Record microphone input on Linux with `ffmpeg`, transcribe it through Groq's OpenAI-compatible API, and insert the text into Pi's editor.

## ✨ Features

- Toggle recording with `Ctrl+Space`.
- Start, stop, and inspect recording state with `/voice`.
- Uses PulseAudio/PipeWire by default, with ALSA support.
- Uses Groq's `whisper-large-v3-turbo` by default.
- Deletes the temporary audio file after transcription.

## 📦 Install

Install from the npm package:

```bash
pi install npm:@narumitw/pi-linux-voice
```

Try it without installing permanently:

```bash
pi -e npm:@narumitw/pi-linux-voice
```

Pi extensions run with the Pi process's permissions. Review the source and install only trusted packages.

## 🚀 Quick start

Install `ffmpeg` and configure a Groq API key:

```bash
sudo apt install ffmpeg
export GROQ_API_KEY="gsk_..."
pi
```

Then press `Ctrl+Space`, speak, and press `Ctrl+Space` again. The transcription is inserted into Pi's editor.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/voice start` | Start recording. |
| `/voice stop` | Stop recording and transcribe. |
| `/voice status` | Show whether recording is active. |

With no argument, `/voice` starts or stops recording based on the current state.

## ⚙️ Settings

The extension uses these environment variables:

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Groq API key. Required unless using the OpenAI-compatible fallback. |
| `PI_VOICE_INPUT=alsa` | Use ALSA instead of PulseAudio/PipeWire. |
| `PI_VOICE_DEVICE` | Select the microphone device; defaults to `default`. |
| `PI_VOICE_TRANSCRIBE_MODEL` | Override the transcription model. |
| `PI_VOICE_TRANSCRIBE_URL` | Override the OpenAI-compatible transcription endpoint. Use only trusted HTTPS endpoints. |
| `PI_VOICE_DEBUG=1` | Print ffmpeg diagnostics. |

Groq free-tier limits vary by account and model. They can include requests and audio usage per minute/day. Daily limits reset at **00:00 UTC**, while per-minute limits recover after the one-minute window. Check current limits at <https://console.groq.com/settings/limits>.

## 🔒 Security and privacy

The extension starts the local `ffmpeg` executable and captures microphone audio. Audio is temporarily stored under the system temporary directory, sent to the configured transcription endpoint, and deleted after transcription. Do not commit `GROQ_API_KEY` or send it to an endpoint you do not trust.

## 🚧 Limitations

- Linux only.
- Requires a working microphone and `ffmpeg`.
- Transcription requires network access and Groq API availability.
- API limits and model availability are controlled by Groq and may change.

## 🗂️ Package layout

```text
packages/pi-linux-voice/
├── src/index.ts                 # Pi entrypoint
├── src/linux-voice.ts           # Recording and transcription implementation
├── dist/                        # Generated Jiti runtime
└── scripts/build-runtime.mjs    # Runtime builder
```

## 🔎 Keywords

Pi extension, voice input, speech-to-text, Linux microphone, ffmpeg, Groq, Whisper, coding agent.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
