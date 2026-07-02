# Codexs Max

Linux desktop shell for local Codex CLI history.

## Run

```bash
npm install
npm run build
npm start
```

For live frontend development:

```bash
npm run dev
```

## Current Scope

- Read local sessions from `~/.codex/state_5.sqlite` and `~/.codex/sessions/**/*.jsonl`.
- Browse, search, and inspect Codex sessions.
- Render Markdown and LaTeX math with KaTeX.
- Export a session to Markdown.
- Show live account token totals and rate limits from `codex app-server`, with local session totals as fallback/context.
- Run a prompt with `codex exec`, or resume the selected session with `codex exec resume`.

## Notes

The app does not write to Codex's own database. Exported Markdown defaults to
`~/文档/codex-exports/`.
