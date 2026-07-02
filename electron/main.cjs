const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sessionsDir = path.join(codexHome, "sessions");
const stateDb = path.join(codexHome, "state_5.sqlite");
const runningCodex = new Map();

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: "Codexs Max",
    backgroundColor: "#f4f5f0",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(rootDir, "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const child of runningCodex.values()) child.kill("SIGTERM");
  runningCodex.clear();
  if (process.platform !== "darwin") app.quit();
});

function querySqlite(dbPath, sql) {
  return new Promise((resolve) => {
    if (!fsSync.existsSync(dbPath)) {
      resolve([]);
      return;
    }
    execFile(
      "sqlite3",
      ["-json", dbPath, sql],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function walkFiles(dir, predicate, found = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, predicate, found);
    } else if (predicate(fullPath)) {
      found.push(fullPath);
    }
  }
  return found;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toMs(value) {
  if (typeof value === "number") {
    return value > 100000000000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function truncateText(text, limit = 12000) {
  if (!text || text.length <= limit) return text || "";
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.text === "string") return item.text;
        if (typeof item.output_text === "string") return item.output_text;
        if (typeof item.input_text === "string") return item.input_text;
        if (item.type === "image" || item.type === "input_image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content.content)) return extractText(content.content);
  return "";
}

function normalizeTokenUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
    cachedInputTokens: Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
    reasoningOutputTokens: Number(
      usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? 0
    ),
    totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0)
  };
}

function normalizeRateLimit(rateLimits) {
  if (!rateLimits) return null;
  const normalizeWindow = (item) => {
    if (!item) return null;
    return {
      usedPercent: Number(item.used_percent ?? item.usedPercent ?? 0),
      windowMinutes: item.window_minutes ?? item.windowDurationMins ?? null,
      resetsAt: item.resets_at ?? item.resetsAt ?? null
    };
  };
  return {
    limitId: rateLimits.limit_id ?? rateLimits.limitId ?? null,
    limitName: rateLimits.limit_name ?? rateLimits.limitName ?? null,
    planType: rateLimits.plan_type ?? rateLimits.planType ?? null,
    primary: normalizeWindow(rateLimits.primary),
    secondary: normalizeWindow(rateLimits.secondary),
    credits: rateLimits.credits ?? null,
    individualLimit: rateLimits.individual_limit ?? rateLimits.individualLimit ?? null,
    rateLimitReachedType:
      rateLimits.rate_limit_reached_type ?? rateLimits.rateLimitReachedType ?? null
  };
}

function parseCodexRecord(record, lineNumber) {
  const timestamp = record?.timestamp ?? null;
  const payload = record?.payload ?? {};

  if (record?.type === "session_meta") {
    return { kind: "meta", timestamp, payload };
  }

  if (record?.type === "response_item") {
    if (payload.type === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") return null;
      const text = extractText(payload.content).trim();
      if (!text) return null;
      return {
        kind: "message",
        id: payload.id || `${lineNumber}-${role}`,
        role,
        phase: payload.phase ?? null,
        timestamp,
        text
      };
    }

    if (payload.type === "function_call") {
      return {
        kind: "tool_call",
        id: payload.id || `${lineNumber}-tool-call`,
        timestamp,
        name: payload.name || "tool",
        text: truncateText(payload.arguments || "", 6000)
      };
    }

    if (payload.type === "function_call_output") {
      return {
        kind: "tool_output",
        id: `${lineNumber}-tool-output`,
        timestamp,
        name: payload.call_id || "output",
        text: truncateText(payload.output || "", 8000)
      };
    }
  }

  if (record?.type === "event_msg" && payload.type === "token_count") {
    return {
      kind: "token_count",
      timestamp,
      usage: {
        total: normalizeTokenUsage(payload.info?.total_token_usage),
        last: normalizeTokenUsage(payload.info?.last_token_usage),
        modelContextWindow: payload.info?.model_context_window ?? null
      },
      rateLimits: normalizeRateLimit(payload.rate_limits)
    };
  }

  return null;
}

async function parseSessionFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages = [];
  const events = [];
  let meta = null;
  let tokenUsage = null;
  let rateLimits = null;

  for (let i = 0; i < lines.length; i += 1) {
    const record = parseJsonLine(lines[i]);
    if (!record) continue;
    const parsed = parseCodexRecord(record, i + 1);
    if (!parsed) continue;
    if (parsed.kind === "meta") {
      meta = parsed.payload;
    } else if (parsed.kind === "message") {
      const previous = messages[messages.length - 1];
      if (!previous || previous.role !== parsed.role || previous.text !== parsed.text) {
        messages.push(parsed);
      }
    } else if (parsed.kind === "token_count") {
      tokenUsage = parsed.usage;
      rateLimits = parsed.rateLimits;
    } else {
      events.push(parsed);
    }
  }

  const stat = await fs.stat(filePath);
  const firstUser = messages.find((item) => item.role === "user");
  const title = firstUser?.text?.split(/\r?\n/)[0]?.slice(0, 160) || path.basename(filePath);
  return {
    id: meta?.session_id || meta?.id || sessionIdFromPath(filePath),
    filePath,
    title,
    preview: firstUser?.text?.slice(0, 280) || "",
    cwd: meta?.cwd || "",
    model: meta?.model || meta?.model_provider || "",
    cliVersion: meta?.cli_version || "",
    source: meta?.source || meta?.originator || "",
    createdAt: toMs(meta?.timestamp) || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs,
    messages,
    events,
    tokenUsage,
    rateLimits
  };
}

function sessionIdFromPath(filePath) {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
  );
  return match?.[1] || filePath;
}

async function scanSessionsFallback() {
  const files = await walkFiles(sessionsDir, (file) => file.endsWith(".jsonl"));
  const summaries = [];
  for (const file of files) {
    try {
      const session = await parseSessionFile(file);
      summaries.push(sessionToSummary(session));
    } catch {
      // Ignore partially written or unreadable sessions.
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

function sessionToSummary(session) {
  return {
    id: session.id,
    filePath: session.filePath,
    title: session.title,
    preview: session.preview,
    cwd: session.cwd,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tokensUsed: session.tokenUsage?.total?.totalTokens ?? 0,
    archived: false,
    source: session.source
  };
}

async function listSessions() {
  const rows = await querySqlite(
    stateDb,
    `select id, rollout_path as filePath, created_at_ms as createdAt,
            updated_at_ms as updatedAt, cwd, title, preview, tokens_used as tokensUsed,
            archived, model, source
       from threads
      order by recency_at_ms desc, updated_at_ms desc
      limit 800`
  );

  if (!rows.length) return scanSessionsFallback();

  return rows
    .filter((row) => row.filePath && fsSync.existsSync(row.filePath))
    .map((row) => ({
      id: row.id,
      filePath: row.filePath,
      title: row.title || row.preview || row.id,
      preview: row.preview || "",
      cwd: row.cwd || "",
      model: row.model || "",
      createdAt: Number(row.createdAt || 0),
      updatedAt: Number(row.updatedAt || 0),
      tokensUsed: Number(row.tokensUsed || 0),
      archived: Boolean(row.archived),
      source: row.source || ""
    }));
}

function markdownEscapeTitle(text) {
  return (text || "Codex Session").replace(/\r?\n/g, " ").trim();
}

function sanitizeFilename(text) {
  return (text || "codex-session")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildMarkdown(session) {
  const lines = [];
  lines.push(`# ${markdownEscapeTitle(session.title)}`);
  lines.push("");
  lines.push(`- Session: \`${session.id}\``);
  if (session.cwd) lines.push(`- CWD: \`${session.cwd}\``);
  if (session.model) lines.push(`- Model: \`${session.model}\``);
  if (session.createdAt) lines.push(`- Created: ${new Date(session.createdAt).toLocaleString()}`);
  if (session.updatedAt) lines.push(`- Updated: ${new Date(session.updatedAt).toLocaleString()}`);
  if (session.tokenUsage?.total?.totalTokens) {
    lines.push(`- Tokens: ${session.tokenUsage.total.totalTokens.toLocaleString()}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of session.messages) {
    const label = message.role === "user" ? "User" : "Assistant";
    const phase = message.phase ? ` (${message.phase})` : "";
    lines.push(`## ${label}${phase}`);
    lines.push("");
    lines.push(message.text.trim());
    lines.push("");
  }

  if (session.events.length) {
    lines.push("## Tool Events");
    lines.push("");
    for (const event of session.events) {
      lines.push(`<details><summary>${event.kind}: ${event.name}</summary>`);
      lines.push("");
      lines.push("```text");
      lines.push(event.text || "");
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

async function findLatestRateLimit() {
  const files = await walkFiles(sessionsDir, (file) => file.endsWith(".jsonl"));
  const sorted = files
    .map((file) => ({ file, mtime: fsSync.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 25);

  for (const item of sorted) {
    try {
      const raw = await fs.readFile(item.file, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const record = parseJsonLine(lines[i]);
        const parsed = record ? parseCodexRecord(record, i + 1) : null;
        if (parsed?.kind === "token_count") {
          return {
            observedAt: parsed.timestamp ? toMs(parsed.timestamp) : item.mtime,
            usage: parsed.usage,
            rateLimits: parsed.rateLimits,
            filePath: item.file
          };
        }
      }
    } catch {
      // Keep searching older sessions.
    }
  }
  return null;
}

async function getUsage() {
  const [summary] = await querySqlite(
    stateDb,
    `select count(*) as sessions,
            coalesce(sum(tokens_used), 0) as totalTokens,
            coalesce(max(tokens_used), 0) as maxTokens,
            coalesce(max(updated_at_ms), 0) as lastUpdated
       from threads
      where archived = 0`
  );

  const daily = await querySqlite(
    stateDb,
    `select date(created_at_ms / 1000, 'unixepoch', 'localtime') as date,
            count(*) as sessions,
            coalesce(sum(tokens_used), 0) as tokens
       from threads
      where archived = 0
      group by date
      order by date desc
      limit 21`
  );

  const byWorkspace = await querySqlite(
    stateDb,
    `select cwd, count(*) as sessions, coalesce(sum(tokens_used), 0) as tokens
       from threads
      where archived = 0
      group by cwd
      order by tokens desc
      limit 8`
  );

  return {
    codexHome,
    summary: {
      sessions: Number(summary?.sessions || 0),
      totalTokens: Number(summary?.totalTokens || 0),
      maxTokens: Number(summary?.maxTokens || 0),
      lastUpdated: Number(summary?.lastUpdated || 0)
    },
    daily: daily.reverse().map((row) => ({
      date: row.date,
      sessions: Number(row.sessions || 0),
      tokens: Number(row.tokens || 0)
    })),
    byWorkspace: byWorkspace.map((row) => ({
      cwd: row.cwd || "",
      sessions: Number(row.sessions || 0),
      tokens: Number(row.tokens || 0)
    })),
    latest: await findLatestRateLimit()
  };
}

function summarizeRunRecord(record) {
  const payload = record?.payload ?? {};
  if (record?.type === "response_item" && payload.type === "message") {
    const text = extractText(payload.content).trim();
    if (text && (payload.role === "assistant" || payload.role === "user")) {
      return { kind: "message", role: payload.role, phase: payload.phase || null, text };
    }
  }
  if (record?.type === "response_item" && payload.type === "function_call") {
    return { kind: "tool", text: `${payload.name || "tool"} ${payload.arguments || ""}`.trim() };
  }
  if (record?.type === "response_item" && payload.type === "function_call_output") {
    return { kind: "tool_output", text: truncateText(payload.output || "", 4000) };
  }
  if (record?.type === "event_msg" && payload.type === "token_count") {
    return {
      kind: "usage",
      usage: {
        total: normalizeTokenUsage(payload.info?.total_token_usage),
        last: normalizeTokenUsage(payload.info?.last_token_usage),
        modelContextWindow: payload.info?.model_context_window ?? null
      },
      rateLimits: normalizeRateLimit(payload.rate_limits)
    };
  }
  if (record?.type === "event_msg") {
    return { kind: "event", text: payload.type || record.type };
  }
  return { kind: "raw", text: record?.type || "record" };
}

ipcMain.handle("sessions:list", () => listSessions());

ipcMain.handle("sessions:read", async (_event, filePath) => {
  return parseSessionFile(filePath);
});

ipcMain.handle("sessions:export", async (_event, filePath) => {
  const session = await parseSessionFile(filePath);
  const defaultDir = path.join(os.homedir(), "文档", "codex-exports");
  await fs.mkdir(defaultDir, { recursive: true });
  const created = session.createdAt
    ? new Date(session.createdAt).toISOString().slice(0, 10)
    : "codex";
  const defaultPath = path.join(defaultDir, `${created}-${sanitizeFilename(session.title)}.md`);
  const result = await dialog.showSaveDialog({
    title: "导出 Markdown",
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, buildMarkdown(session), "utf8");
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("usage:get", () => getUsage());

ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  return shell.openPath(targetPath);
});

ipcMain.handle("shell:showItem", (_event, targetPath) => {
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle("codex:run", (event, options) => {
  const prompt = String(options?.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is empty.");

  const runId = crypto.randomUUID();
  const cwd = options?.cwd || os.homedir();
  const model = String(options?.model || "").trim();
  const sessionId = String(options?.sessionId || "").trim();
  const args = sessionId
    ? ["exec", "resume", "--json", "--all"]
    : ["exec", "--json", "--color", "never", "-C", cwd, "--skip-git-repo-check"];

  if (model) args.push("-m", model);
  if (sessionId) args.push(sessionId, prompt);
  else args.push(prompt);

  const child = spawn("codex", args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  runningCodex.set(runId, child);

  const send = (payload) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("codex:run-event", { runId, ...payload });
    }
  };

  send({ kind: "started", args: ["codex", ...args] });

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = parseJsonLine(line);
      send({
        kind: "record",
        raw: line,
        record: record || null,
        summary: record ? summarizeRunRecord(record) : { kind: "stdout", text: line }
      });
    }
  });

  child.stderr.on("data", (chunk) => {
    send({ kind: "stderr", text: chunk.toString("utf8") });
  });

  child.on("error", (error) => {
    runningCodex.delete(runId);
    send({ kind: "error", text: error.message });
  });

  child.on("close", (code, signal) => {
    runningCodex.delete(runId);
    if (stdoutBuffer.trim()) {
      const record = parseJsonLine(stdoutBuffer.trim());
      send({
        kind: "record",
        raw: stdoutBuffer.trim(),
        record: record || null,
        summary: record ? summarizeRunRecord(record) : { kind: "stdout", text: stdoutBuffer.trim() }
      });
    }
    send({ kind: "done", code, signal });
  });

  return { runId };
});

ipcMain.handle("codex:cancel", (_event, runId) => {
  const child = runningCodex.get(runId);
  if (!child) return false;
  child.kill("SIGTERM");
  runningCodex.delete(runId);
  return true;
});

