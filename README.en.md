<p align="right"><b>English</b> · <a href="README.md">中文</a></p>

<div align="center">

<img src="assets/codexdesk.svg" width="96" height="96" alt="Codex Desk" />

# Codex Desk

**Codex Linux desktop.**

Manage and export local Codex sessions, with real-time usage visibility.

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

Most AI desktop tools try to become everything at once: Git clients, IDE panels,
project managers, dashboards, and chat apps. That can be powerful, but it also
adds a lot of surface area for users who only need to find, read, keep, and
export their work.

Codex Desk is built around two needs:

1. **Session management and export** — Codex CLI stores valuable work as local
   JSONL sessions plus a SQLite index. Codex Desk makes that history searchable,
   readable, pinnable, archivable, deletable, and exportable without asking the
   user to understand the storage layout or touch Git.
2. **Formula typography** — many Codex sessions contain Markdown, LaTeX, and
   research notes. The app should show formulas as formulas, not raw source
   code, so old conversations remain useful when reviewed later.

Everything else is secondary. Usage panels, theme switching, and in-place prompt
runs exist to support that workflow, not to make the app feel bigger than it
needs to be.

## Core Features

- **Session library** — merges the SQLite index (`state_5.sqlite`, `threads`)
  with on-disk JSONL rollouts, de-duplicated and sorted by recency. Works even
  when one source is missing.
- **Practical session controls** — search, rename, pin, archive, collapse the
  list, copy the `codex resume` id, locate the JSONL file, and safely delete by
  moving sessions to `deleted_sessions/`.
- **Markdown export** — export the selected conversation to
  `~/文档/codex-exports/` for sharing, filing, or long-term storage.
- **Readable conversation rendering** — GFM Markdown plus KaTeX math rendering
  for `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` style formulas. Code blocks
  stay untouched.

## Supporting Features

- **Live usage & quota** — total tokens, rate-limit windows, latest-token
  breakdown, and a daily usage chart.
- **Run & resume in place** — send a prompt with `codex exec`, or resume the
  selected session with `codex exec resume`.
- **Light / dark themes** and a resizable session rail.

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

`scripts/launch-codexdesk.sh` starts the app with a fixed `CODEX_HOME`. Point a
`.desktop` entry's `Exec` at it and its `Icon` at `assets/codexdesk.svg`.

## Tech stack

`Electron 39` · `React 19` · `Vite 7` · `TypeScript` · `react-markdown` +
`remark-gfm` + `remark-math` + `rehype-katex` (KaTeX) · `lucide-react`.

## Status

`v0.1.0` — early but daily-drivable. Linux/X11 focused.
