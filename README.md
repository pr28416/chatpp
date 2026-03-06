# Chat++ (imessage-search-desktop)

Desktop app for browsing, searching, and timeline-indexing your local iMessage history.

This repo is a **Tauri v2 + React + TypeScript** app with a Rust backend that reads `~/Library/Messages/chat.db`.

## Features

- Chat list + message viewer for local iMessage data
- Full-text search with optional date filtering
- Attachment resolution (including HEIC -> JPEG conversion on macOS)
- Contact name/photo enrichment from macOS Address Book databases
- AI-assisted timeline indexing with topic and subtopic views

## Stack

- Frontend: Vite, React 19, TypeScript, Tailwind CSS v4
- Desktop shell/backend: Tauri v2, Rust, `rusqlite`
- Data sources:
  - iMessage DB: `~/Library/Messages/chat.db`
  - Contacts DB(s): `~/Library/Application Support/AddressBook/...`

## Prerequisites

- macOS (required for iMessage data access and current path assumptions)
- Node.js 20+ and npm
- Rust toolchain (stable) with Cargo
- Tauri CLI dependencies for macOS (Xcode Command Line Tools, etc.)

## Setup

```bash
npm install
npm install --prefix assistant-agent
```

Optional: create a `.env` in repo root (or `src-tauri/.env`) for AI timeline indexing:

```bash
OPENAI_API_KEY=your_key_here
# Optional assistant provider keys:
# ANTHROPIC_API_KEY=your_key_here
# GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
# XAI_API_KEY=your_key_here
# Optional model overrides:
# OPENAI_MODEL=gpt-5-nano
# OPENAI_MODEL_TIMELINE_TEXT=gpt-5-nano
# OPENAI_MODEL_TIMELINE_MEDIA=gpt-5-nano
```

## Run

- Web frontend only:

```bash
npm run dev
```

- Full desktop app (recommended):

```bash
npm run tauri:dev
```

`tauri:dev` automatically picks an open local frontend port so multiple worktrees can run in parallel. To pin a specific port for a run, set `TAURI_DEV_PORT` (example: `TAURI_DEV_PORT=1520 npm run tauri:dev`).

## Build

```bash
npm run tauri:build
```

Also available:

- `npm run build` (frontend build only)
- `npm run preview` (preview frontend build)

## macOS Permissions

The app reads protected system databases. You will typically need **Full Disk Access** for your terminal/dev app (and packaged app) in:

`System Settings -> Privacy & Security -> Full Disk Access`

If access is missing, chat loading will fail and the app logs a warning about `chat.db` not being found.

## Environment Variables

The app loads `.env` from either:

- `./.env`
- `./src-tauri/.env`

### Core

- `OPENAI_API_KEY`: enables AI timeline generation and image captioning
- `ANTHROPIC_API_KEY`: enables Anthropic models for assistant chat
- `GOOGLE_GENERATIVE_AI_API_KEY`: enables Gemini models for assistant chat
- `XAI_API_KEY`: enables xAI Grok models for assistant chat
- `OPENAI_MODEL`: default model fallback for timeline calls (default: `gpt-5-nano`)
- `OPENAI_MODEL_TIMELINE_TEXT`: override model for timeline text generation
- `OPENAI_MODEL_TIMELINE_MEDIA`: override model for image captioning
- `TIMELINE_DB_PATH`: override location of the timeline SQLite DB (default: `~/Library/Application Support/imessage-search-desktop/timeline.db`)
- `TIMELINE_AI_MOCK`: `1`/`true` to bypass live OpenAI calls and return mock AI output

### Assistant model selector

- The AI sidebar includes a session-only model selector for assistant chat.
- Supported providers: OpenAI, Anthropic, Google Gemini, xAI.
- The selected model applies to assistant turns only and resets on app restart.
- Timeline indexing continues to use `OPENAI_MODEL*` environment settings.

### Timeline tuning

- `TIMELINE_WINDOW_MAX_MESSAGES` (20..200, default `120`)
- `TIMELINE_WINDOW_TARGET_CHARS` (3000..60000, default `18000`)
- `TIMELINE_WINDOW_OVERLAP_MESSAGES` (1..60, default `24`)
- `TIMELINE_L0_CONTEXT_ITEMS` (4..64, default `16`)
- `TIMELINE_IMAGE_WORKERS` (1..12, default `6`)
- `TIMELINE_IMAGE_RETRIES` (1..6, default `3`)
- `TIMELINE_SUBTOPIC_MAX_MOMENTS` (2..20, default `6`)
- `TIMELINE_SUBTOPIC_MIN_MOMENTS` (1..10, default `2`)
- `TIMELINE_SUBTOPIC_SPLIT_GAP_HOURS` (1..168, default `18`)
- `TIMELINE_L0_MIN_COMPLETE_COVERAGE` (0.05..1.0, default `0.60`)

## Project Layout

```text
src/            # React app (chat UI, search UI, timeline UI)
src-tauri/      # Rust backend, Tauri config, DB + indexing logic
example/        # Separate UI playground/example app
```

## Notes

- Main product name in Tauri config: `Chat++`
- Bundle identifier: `com.imessage-search.desktop`
- Dev frontend defaults to `http://localhost:1420` and auto-falls forward to the next open port in `tauri:dev`.
