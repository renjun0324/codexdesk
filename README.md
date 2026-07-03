<p align="right"><b>English</b> · <a href="README.zh-CN.md">中文</a></p>

<div align="center">

<img src="assets/codexdesk.svg" width="96" height="96" alt="Codex Desk" />

# Codex Desk

**A fast Linux desktop for your local Codex CLI history.**

Browse, search, read, rename, and export every Codex session — plus live token &
quota tracking and a built-in prompt runner — without touching the terminal.

<sub>Electron · React 19 · Vite · TypeScript</sub>

</div>

---

<div align="center">
  <img src="assets/screenshots/overview.png" width="900" alt="Codex Desk overview" />
  <br/>
  <sub>Three-pane workspace: session list · rendered conversation · live usage.</sub>
</div>

---

## Why

Codex CLI writes every session to `~/.codex` as JSONL rollouts plus a SQLite
index. That history is rich but effectively invisible from the terminal. Codex
Desk turns it into a real desktop app: a searchable library on the left, the
fully rendered conversation (Markdown + LaTeX) in the middle, and account usage
on the right — with the ability to resume or start a run in place.

## Features

- **Unified session library** — merges the SQLite index (`state_5.sqlite`,
  `threads`) with the on-disk JSONL rollouts, de-duplicated and sorted by
  recency. Works even when one source is missing.
- **Full conversation rendering** — Markdown via `react-markdown` + GFM, and math
  via `remark-math` + KaTeX. Reads like the real thread, not raw JSON.
- **Search & filter** — instant filter across title, id, preview, cwd, and model;
  optional archived sessions.
- **Rename that sticks** — custom titles are stored in an app-owned sidecar so an
  active Codex session can't overwrite them on its next turn. (Codex owns the
  `threads.title` column and regenerates it — Codex Desk works *around* that.)
- **Safe delete** — the JSONL is moved to `deleted_sessions/` (recoverable), and
  the index rows are cleaned up. Nothing is shredded.
- **Live usage & quota** — total tokens, per-window rate limits, latest-token
  breakdown (input/output/cache/reasoning), and a daily usage chart, pulled from
  `codex app-server` with local session totals as fallback.
- **Run & resume in place** — send a prompt with `codex exec`, or resume the
  selected session with `codex exec resume`, streaming events back into the pane.
- **Export to Markdown** — one click to `~/文档/codex-exports/`.
- **Light / dark themes**, a resizable session rail, and multi-`CODEX_HOME`
  support.

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/screenshots/usage.png" alt="Usage and quota panel" />
      <p align="center"><sub><b>Usage & quota</b> — tokens, rate-limit windows, daily chart</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/screenshots/composer.png" alt="Prompt composer" />
      <br/><br/>
      <p align="center"><sub><b>Composer</b> — run a prompt or resume the current session</sub></p>
    </td>
  </tr>
</table>

## Install & run

Requirements: **Node 18+**, the **Codex CLI** on your `PATH`, and `sqlite3`
(a bundled `python3` fallback is used if the CLI is unavailable).

```bash
npm install
npm run build
npm start
```

Live frontend development (Vite hot-reload, no rebuild needed):

```bash
npm run dev
```

### Desktop launcher (Linux)

`scripts/launch-codexdesk.sh` starts the app with a synced `CODEX_HOME`. Point a
`.desktop` entry's `Exec` at it and its `Icon` at `assets/codexdesk.svg`.

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│ Electron main  (electron/main.cjs)                           │
│   • reads  ~/.codex/state_5.sqlite  + sessions/**/*.jsonl     │
│   • spawns codex exec / app-server                            │
│   • sidecar title overrides  (codexdesk-title-overrides.json) │
└───────────────▲───────────────────────────┬──────────────────┘
                │ contextIsolated IPC        │ window.codexDesk.*
        ┌───────┴───────┐          ┌─────────▼─────────┐
        │ preload.cjs   │          │ React renderer    │
        │ (safe bridge) │          │ (Vite build → dist)│
        └───────────────┘          └───────────────────┘
```

The renderer never touches the filesystem or child processes directly —
everything goes through a small, explicit IPC surface (`sessions:*`, `usage:get`,
`codex:run`, `shell:*`) exposed by the preload script.

## Data & privacy

- Session data is read from your local `CODEX_HOME` (default `~/.codex`).
- Renames update Codex's local `threads` index **and** an app-owned sidecar file;
  deletes move JSONL to `deleted_sessions/` and remove the matching index rows.
- Nothing is uploaded anywhere. Exports default to `~/文档/codex-exports/`.

## Tech stack

`Electron 39` · `React 19` · `Vite 7` · `TypeScript` · `react-markdown` +
`remark-gfm` + `remark-math` + `rehype-katex` (KaTeX) · `lucide-react`.

## Status

`v0.1.0` — early but daily-drivable. Linux/X11 focused.
