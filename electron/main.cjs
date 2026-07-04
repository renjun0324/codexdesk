const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const fallbackCodexHome =
  findProjectCodexHome(rootDir) ||
  findProjectCodexHome(process.cwd()) ||
  path.join(rootDir, ".codex");
const codexHome = path.resolve(expandHome(process.env.CODEX_HOME || fallbackCodexHome));
const codexHomes = [codexHome];
const sessionsDir = path.join(codexHome, "sessions");
const deletedSessionsDir = path.join(codexHome, "deleted_sessions");
const stateDb = path.join(codexHome, "state_5.sqlite");
const modelsCache = path.join(codexHome, "models_cache.json");
const runningCodex = new Map();
let mainWindow = null;
const CODEX_RUN_IDLE_TIMEOUT_MS = 120000;
// GUI launches (.desktop / dock) do not inherit the shell proxy, so Codex would
// reach the OpenAI backend directly. In network-restricted regions that hangs
// forever in TCP SYN-SENT and the run returns no assistant reply. Fall back to a
// local proxy unless one is already present. Override or disable via CODEX_DESK_PROXY
// (set CODEX_DESK_PROXY="" to opt out entirely).
const fallbackProxy =
  process.env.CODEX_DESK_PROXY != null
    ? process.env.CODEX_DESK_PROXY
    : "http://127.0.0.1:7890";
const fallbackModels = [
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5-codex", name: "GPT-5 / Codex" },
  { id: "gpt-5", name: "GPT-5" }
];

function readProcessArgs(pid) {
  try {
    return fsSync.readFileSync(path.join("/proc", String(pid), "cmdline"), "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function listActiveSessionProcesses(sessionId) {
  const target = String(sessionId || "").trim();
  if (!target || process.platform !== "linux") return [];
  let entries = [];
  try {
    entries = fsSync.readdirSync("/proc");
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => {
      const pid = Number(entry);
      const args = readProcessArgs(pid);
      return { pid, args };
    })
    .filter(({ pid, args }) => {
      if (!args.length || pid === process.pid) return false;
      const command = args.join(" ");
      if (!command.includes("codex") || !args.includes(target)) return false;
      return args.includes("resume") && (args.includes("exec") || args[1] === "resume");
    });
}

function descendantPids(rootPid) {
  if (process.platform !== "linux" || !rootPid) return [];
  let entries = [];
  try {
    entries = fsSync.readdirSync("/proc");
  } catch {
    return [];
  }

  const childrenByParent = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const status = fsSync.readFileSync(path.join("/proc", entry, "status"), "utf8");
      const match = status.match(/^PPid:\s+(\d+)/m);
      if (!match) continue;
      const ppid = Number(match[1]);
      const children = childrenByParent.get(ppid) || [];
      children.push(pid);
      childrenByParent.set(ppid, children);
    } catch {
      // Process exited while scanning.
    }
  }

  const found = [];
  const stack = [rootPid];
  while (stack.length) {
    const current = stack.pop();
    const children = childrenByParent.get(current) || [];
    for (const childPid of children) {
      found.push(childPid);
      stack.push(childPid);
    }
  }
  return found;
}

function killCodexRun(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing known descendants below.
    }
  }

  const pids = [...descendantPids(child.pid).reverse(), child.pid];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

function buildCodexEnv() {
  const env = {};
  const keepExact = [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "USERNAME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SSH_AUTH_SOCK",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "OPENAI_API_KEY"
  ];
  const keepPrefixes = [
    "CODEX_",
    "XDG_",
    "GTK_",
    "QT_",
    "SDL_",
    "CLUTTER_"
  ];
  const keepProxy = /^(https?|all|no|wss?|ftp)_proxy$/i;

  for (const key of keepExact) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (keepPrefixes.some((prefix) => key.startsWith(prefix)) || keepProxy.test(key)) {
      env[key] = value;
    }
  }
  const hasProxy = Object.keys(env).some((key) => keepProxy.test(key));
  if (!hasProxy && fallbackProxy) {
    env.HTTPS_PROXY = fallbackProxy;
    env.HTTP_PROXY = fallbackProxy;
    env.ALL_PROXY = fallbackProxy;
    if (env.NO_PROXY == null) env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  env.CODEX_HOME = codexHome;
  return env;
}

function findProjectCodexHome(startDir) {
  let current = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  while (current && current !== path.dirname(current)) {
    if (current === home) break;
    const candidate = path.join(current, ".codex");
    if (fsSync.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

function codexHomePaths(targetCodexHome) {
  return {
    codexHome: targetCodexHome,
    sessionsDir: path.join(targetCodexHome, "sessions"),
    deletedSessionsDir: path.join(targetCodexHome, "deleted_sessions"),
    stateDb: path.join(targetCodexHome, "state_5.sqlite")
  };
}

function configureLinuxInputMethod() {
  if (process.platform !== "linux") return;
  const normalizeInputMethod = (value) => {
    if (!value) return null;
    const lower = String(value).toLowerCase();
    if (lower === "fcitx5") return "fcitx";
    if (lower === "fcitx") return "fcitx";
    if (lower === "ibus") return "ibus";
    return null;
  };

  const hasProcess = (names) => {
    try {
      return fsSync.readdirSync("/proc").some((entry) => {
        if (!/^\d+$/.test(entry)) return false;
        const commPath = path.join("/proc", entry, "comm");
        const cmdlinePath = path.join("/proc", entry, "cmdline");
        const comm = fsSync.existsSync(commPath)
          ? fsSync.readFileSync(commPath, "utf8").trim()
          : "";
        const cmdline = fsSync.existsSync(cmdlinePath)
          ? fsSync.readFileSync(cmdlinePath, "utf8").replace(/\0/g, " ")
          : "";
        return names.some((name) => comm === name || cmdline.includes(name));
      });
    } catch {
      return false;
    }
  };

  const xModifierMatch = String(process.env.XMODIFIERS || "").match(/@im=([^;]+)/i);
  const configured = [
    process.env.GTK_IM_MODULE,
    process.env.QT_IM_MODULE,
    xModifierMatch?.[1]
  ]
    .filter(Boolean)
    .map(normalizeInputMethod)
    .filter(Boolean);

  const running = hasProcess(["fcitx5", "fcitx"]) ? "fcitx" : hasProcess(["ibus-daemon"]) ? "ibus" : null;
  const fallback = fsSync.existsSync(path.join(os.homedir(), ".config", "fcitx5")) ||
    fsSync.existsSync(path.join(os.homedir(), ".config", "fcitx"))
    ? "fcitx"
    : fsSync.existsSync(path.join(os.homedir(), ".config", "ibus"))
      ? "ibus"
      : null;
  const inputMethod = configured.find((value) => value === "fcitx" || value === "ibus") || running || fallback;

  if (inputMethod) {
    process.env.GTK_IM_MODULE ||= inputMethod;
    process.env.QT_IM_MODULE ||= inputMethod;
    process.env.XMODIFIERS ||= `@im=${inputMethod}`;
    process.env.SDL_IM_MODULE ||= inputMethod;
    process.env.CLUTTER_IM_MODULE ||= inputMethod;
  }

  app.commandLine.appendSwitch("enable-wayland-ime");
}

configureLinuxInputMethod();

function expandHome(candidate) {
  if (!candidate) return candidate;
  if (candidate === "~") return os.homedir();
  if (candidate.startsWith("~/")) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

function resolveCodexBinary() {
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(expandHome(dir), "codex"));

  const candidates = [
    process.env.CODEX_BIN,
    ...pathCandidates,
    path.join(os.homedir(), "wechat-web-devtools-linux/cache/npm/node_global/bin/codex"),
    path.join(os.homedir(), ".npm-global/bin/codex"),
    path.join(os.homedir(), ".local/bin/codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return "codex";
}

const codexBinary = resolveCodexBinary();

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: "Codex Desk",
    icon: path.join(rootDir, "assets", "codexdesk.svg"),
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

  win.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    console.error(`[renderer:load-failed] ${code} ${description} ${validatedUrl}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${JSON.stringify(details)}`);
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  return win;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  for (const run of runningCodex.values()) killCodexRun(run.child);
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
        if (error) {
          querySqliteWithPython(dbPath, sql).then(resolve);
          return;
        }
        if (!stdout.trim()) {
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

function querySqliteWithPython(dbPath, sql) {
  return new Promise((resolve) => {
    const script = `
import json
import sqlite3
import sys

db_path, query = sys.argv[1], sys.argv[2]
connection = None
try:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(query).fetchall()
    print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
except Exception:
    sys.exit(1)
finally:
    if connection is not None:
        connection.close()
`;
    execFile(
      "python3",
      ["-c", script, dbPath, sql],
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

function execSqlite(dbPath, sql) {
  return new Promise((resolve, reject) => {
    if (!fsSync.existsSync(dbPath)) {
      reject(new Error("Codex state database was not found."));
      return;
    }
    execFile("sqlite3", [dbPath, sql], { maxBuffer: 1024 * 1024 }, (error) => {
      if (error) {
        execSqliteWithPython(dbPath, sql).then(resolve, reject);
        return;
      }
      resolve(true);
    });
  });
}

function execSqliteWithPython(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const script = `
import sqlite3
import sys

db_path, query = sys.argv[1], sys.argv[2]
connection = sqlite3.connect(db_path)
try:
    connection.executescript(query)
    connection.commit()
finally:
    connection.close()
`;
    execFile("python3", ["-c", script, dbPath, sql], { maxBuffer: 1024 * 1024 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(true);
    });
  });
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Custom session titles live in an app-owned sidecar file. Codex owns the
// `threads.title` column and regenerates it from the first user message on
// every turn, so a rename written only to the DB is clobbered by any active
// session. The override store is applied at top priority when listing.
function titleOverridesPath(targetCodexHome) {
  return path.join(targetCodexHome, "codexdesk-title-overrides.json");
}

function pinnedSessionsPath(targetCodexHome) {
  return path.join(targetCodexHome, "codexdesk-pinned-sessions.json");
}

function archivedSessionsPath(targetCodexHome) {
  return path.join(targetCodexHome, "codexdesk-archived-sessions.json");
}

async function readTitleOverrides(targetCodexHome) {
  try {
    const raw = await fs.readFile(titleOverridesPath(targetCodexHome), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTitleOverride(targetCodexHome, id, title) {
  const overrides = await readTitleOverrides(targetCodexHome);
  const next = { ...overrides, [id]: title };
  await fs.writeFile(titleOverridesPath(targetCodexHome), JSON.stringify(next, null, 2), "utf8");
}

async function removeTitleOverride(targetCodexHome, id) {
  const overrides = await readTitleOverrides(targetCodexHome);
  if (!(id in overrides)) return;
  const next = { ...overrides };
  delete next[id];
  await fs.writeFile(titleOverridesPath(targetCodexHome), JSON.stringify(next, null, 2), "utf8");
}

async function readPinnedSessions(targetCodexHome) {
  try {
    const raw = await fs.readFile(pinnedSessionsPath(targetCodexHome), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map(String).filter(Boolean));
    }
    if (Array.isArray(parsed?.pinned)) {
      return new Set(parsed.pinned.map(String).filter(Boolean));
    }
    if (parsed && typeof parsed === "object") {
      return new Set(
        Object.entries(parsed)
          .filter(([, value]) => Boolean(value))
          .map(([key]) => key)
      );
    }
  } catch {
    // Missing or malformed pin state is treated as empty.
  }
  return new Set();
}

async function writePinnedSessions(targetCodexHome, ids) {
  await fs.mkdir(targetCodexHome, { recursive: true });
  const ordered = [...ids].filter(Boolean).sort();
  await fs.writeFile(pinnedSessionsPath(targetCodexHome), JSON.stringify(ordered, null, 2), "utf8");
}

async function writePinnedSession(targetCodexHome, ids, pinned) {
  const existing = await readPinnedSessions(targetCodexHome);
  for (const id of ids.filter(Boolean)) {
    if (pinned) {
      existing.add(id);
    } else {
      existing.delete(id);
    }
  }
  await writePinnedSessions(targetCodexHome, existing);
}

async function removePinnedSession(targetCodexHome, ...ids) {
  const existing = await readPinnedSessions(targetCodexHome);
  let changed = false;
  for (const id of ids.filter(Boolean)) {
    changed = existing.delete(id) || changed;
  }
  if (changed) await writePinnedSessions(targetCodexHome, existing);
}

function isPinnedSession(summary, pinnedIds) {
  return pinnedIds.has(summary.id) || pinnedIds.has(summary.resumeId);
}

async function readArchivedSessions(targetCodexHome) {
  try {
    const raw = await fs.readFile(archivedSessionsPath(targetCodexHome), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map(String).filter(Boolean));
    }
    if (Array.isArray(parsed?.archived)) {
      return new Set(parsed.archived.map(String).filter(Boolean));
    }
    if (parsed && typeof parsed === "object") {
      return new Set(
        Object.entries(parsed)
          .filter(([, value]) => Boolean(value))
          .map(([key]) => key)
      );
    }
  } catch {
    // Missing or malformed archive state is treated as empty.
  }
  return new Set();
}

async function writeArchivedSessions(targetCodexHome, ids) {
  await fs.mkdir(targetCodexHome, { recursive: true });
  const ordered = [...ids].filter(Boolean).sort();
  await fs.writeFile(archivedSessionsPath(targetCodexHome), JSON.stringify(ordered, null, 2), "utf8");
}

async function writeArchivedSession(targetCodexHome, ids, archived) {
  const existing = await readArchivedSessions(targetCodexHome);
  for (const id of ids.filter(Boolean)) {
    if (archived) {
      existing.add(id);
    } else {
      existing.delete(id);
    }
  }
  await writeArchivedSessions(targetCodexHome, existing);
}

async function removeArchivedSession(targetCodexHome, ...ids) {
  const existing = await readArchivedSessions(targetCodexHome);
  let changed = false;
  for (const id of ids.filter(Boolean)) {
    changed = existing.delete(id) || changed;
  }
  if (changed) await writeArchivedSessions(targetCodexHome, existing);
}

function isArchivedSession(summary, archivedIds) {
  return archivedIds.has(summary.id) || archivedIds.has(summary.resumeId);
}

function isInsideDir(candidate, parent) {
  const resolved = path.resolve(candidate);
  const root = path.resolve(parent);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function findCodexHomeForSessionPath(filePath) {
  const sourcePath = path.resolve(filePath);
  return codexHomes.find((targetCodexHome) =>
    isInsideDir(sourcePath, path.join(targetCodexHome, "sessions"))
  ) || null;
}

function mergeableCommentary(previous, next) {
  return (
    previous &&
    next &&
    previous.kind === "message" &&
    next.kind === "message" &&
    previous.role === "assistant" &&
    next.role === "assistant" &&
    previous.phase === "commentary" &&
    next.phase === "commentary"
  );
}

function appendSessionMessage(messages, next) {
  const previous = messages[messages.length - 1];
  if (mergeableCommentary(previous, next)) {
    previous.text = `${previous.text.trim()}\n\n${next.text.trim()}`.trim();
    previous.timestamp = next.timestamp || previous.timestamp;
    previous.id = `${previous.id}+${next.id}`;
    return;
  }
  if (!previous || previous.role !== next.role || previous.text !== next.text) {
    messages.push(next);
  }
}

function timestampPathSegment() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
  let value = text;
  if (typeof value !== "string") {
    value = extractText(value);
    if (!value) {
      try {
        value = JSON.stringify(text, null, 2);
      } catch {
        value = String(text || "");
      }
    }
  }
  if (!value || value.length <= limit) return value || "";
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`;
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
  if (content.type === "image" || content.type === "input_image") return "[image]";
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

function normalizeAccountUsageResponse(response) {
  if (!response) return null;
  const summary = response.summary || {};
  return {
    summary: {
      lifetimeTokens:
        summary.lifetimeTokens == null ? null : Number(summary.lifetimeTokens),
      peakDailyTokens:
        summary.peakDailyTokens == null ? null : Number(summary.peakDailyTokens),
      longestRunningTurnSec:
        summary.longestRunningTurnSec == null
          ? null
          : Number(summary.longestRunningTurnSec),
      currentStreakDays:
        summary.currentStreakDays == null ? null : Number(summary.currentStreakDays),
      longestStreakDays:
        summary.longestStreakDays == null ? null : Number(summary.longestStreakDays)
    },
    dailyUsageBuckets: Array.isArray(response.dailyUsageBuckets)
      ? response.dailyUsageBuckets.map((bucket) => ({
          startDate: bucket.startDate,
          tokens: Number(bucket.tokens || 0)
        }))
      : null
  };
}

function normalizeRateLimitsResponse(response) {
  if (!response) return null;
  const rateLimitsByLimitId = response.rateLimitsByLimitId || null;
  const normalizedByLimitId = rateLimitsByLimitId
    ? Object.fromEntries(
        Object.entries(rateLimitsByLimitId).map(([key, value]) => [
          key,
          normalizeRateLimit(value)
        ])
      )
    : null;

  return {
    rateLimits: normalizeRateLimit(response.rateLimits),
    rateLimitsByLimitId: normalizedByLimitId,
    rateLimitResetCredits: response.rateLimitResetCredits || null
  };
}

async function listModels() {
  try {
    const raw = await fs.readFile(modelsCache, "utf8");
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const seen = new Set();
    const normalized = models
      .filter((model) =>
        model?.slug &&
        model.visibility === "list" &&
        model.supported_in_api !== false
      )
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
      .map((model) => ({
        id: String(model.slug),
        name: String(model.display_name || model.slug)
      }))
      .filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      });
    return normalized.length ? normalized : fallbackModels;
  } catch {
    return fallbackModels;
  }
}

async function resolveRunModel(candidate) {
  const requested = String(candidate || "").trim();
  const models = await listModels();
  const ids = new Set(models.map((model) => model.id));
  if (requested && ids.has(requested)) return requested;
  if (ids.has("gpt-5.5")) return "gpt-5.5";
  return models[0]?.id || "gpt-5.5";
}

function queryAppServerUsage() {
  return new Promise((resolve) => {
    const child = spawn(codexBinary, ["app-server", "--stdio"], {
      env: buildCodexEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const state = {
      initialized: false,
      rateLimits: null,
      usage: null,
      stderr: "",
      buffer: ""
    };

    let finished = false;
    const timeout = setTimeout(() => finish(), 12000);

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill("SIGTERM");
      resolve({
        available: Boolean(state.rateLimits || state.usage),
        observedAt: Date.now(),
        rateLimits: state.rateLimits,
        usage: state.usage,
        codexBinary,
        error: state.rateLimits || state.usage ? null : state.stderr.trim() || null
      });
    };

    const maybeFinish = () => {
      if (state.rateLimits && state.usage) finish();
    };

    const handleMessage = (message) => {
      if (message.id === 1 && !state.initialized) {
        state.initialized = true;
        send({ method: "initialized" });
        send({ method: "account/rateLimits/read", id: 2 });
        send({ method: "account/usage/read", id: 3 });
        return;
      }
      if (message.id === 2) {
        state.rateLimits = normalizeRateLimitsResponse(message.result);
        maybeFinish();
        return;
      }
      if (message.id === 3) {
        state.usage = normalizeAccountUsageResponse(message.result);
        maybeFinish();
      }
    };

    child.on("error", (error) => {
      state.stderr += error.message;
      finish();
    });

    child.stderr.on("data", (chunk) => {
      state.stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      state.buffer += chunk.toString("utf8");
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = parseJsonLine(line);
        if (message) handleMessage(message);
      }
    });

    child.on("close", () => {
      if (state.buffer.trim()) {
        const message = parseJsonLine(state.buffer.trim());
        if (message) handleMessage(message);
      }
      finish();
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "codex-desk", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      }
    });
  });
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
      appendSessionMessage(messages, parsed);
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
  const resumeId = resumeIdFromPath(filePath) || meta?.session_id || meta?.id || "";
  return {
    id: meta?.session_id || meta?.id || sessionIdFromPath(filePath),
    resumeId: resumeId || sessionIdFromPath(filePath),
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
  return resumeIdFromPath(filePath) || filePath;
}

function resumeIdFromPath(filePath) {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
  );
  return match?.[1] || "";
}

async function scanSessionsFallback(targetSessionsDir = sessionsDir) {
  const files = await walkFiles(targetSessionsDir, (file) => file.endsWith(".jsonl"));
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
    resumeId: session.resumeId || session.id,
    filePath: session.filePath,
    title: session.title,
    preview: session.preview,
    cwd: session.cwd,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tokensUsed: session.tokenUsage?.total?.totalTokens ?? 0,
    archived: false,
    pinned: Boolean(session.pinned),
    source: session.source
  };
}

function threadRowToSummary(row) {
  return {
    id: row.id,
    resumeId: resumeIdFromPath(row.filePath) || row.id,
    filePath: row.filePath,
    title: row.title || row.preview || row.id,
    preview: row.preview || "",
    cwd: row.cwd || "",
    model: row.model || "",
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    tokensUsed: Number(row.tokensUsed || 0),
    archived: Boolean(row.archived),
    pinned: false,
    source: row.source || ""
  };
}

function sessionSummaryKey(session) {
  return path.resolve(session.filePath || session.resumeId || session.id);
}

function sessionIdentityKey(session) {
  return session.resumeId || session.id || session.filePath;
}

function mergeSessionSummary(dbSummary, fileSummary) {
  const dbTitle = dbSummary.title && dbSummary.title !== dbSummary.id ? dbSummary.title : "";
  return {
    ...fileSummary,
    ...dbSummary,
    resumeId: dbSummary.resumeId || fileSummary.resumeId || dbSummary.id || fileSummary.id,
    title: dbTitle || fileSummary.title || dbSummary.title || dbSummary.id || fileSummary.id,
    preview: dbSummary.preview || fileSummary.preview || "",
    cwd: dbSummary.cwd || fileSummary.cwd || "",
    model: dbSummary.model || fileSummary.model || "",
    createdAt: dbSummary.createdAt || fileSummary.createdAt || 0,
    updatedAt: Math.max(dbSummary.updatedAt || 0, fileSummary.updatedAt || 0),
    tokensUsed: Math.max(dbSummary.tokensUsed || 0, fileSummary.tokensUsed || 0),
    source: dbSummary.source || fileSummary.source || ""
  };
}

function dedupeSessionSummaries(summaries) {
  const byIdentity = new Map();
  for (const summary of summaries) {
    const key = sessionIdentityKey(summary);
    const current = byIdentity.get(key);
    if (!current || (summary.pinned && !current.pinned) || summary.updatedAt > current.updatedAt) {
      byIdentity.set(key, summary);
    }
  }
  return [...byIdentity.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

async function listSessionsForHome(targetCodexHome) {
  const paths = codexHomePaths(targetCodexHome);
  const rows = await querySqlite(
    paths.stateDb,
    `select id, rollout_path as filePath, created_at_ms as createdAt,
            updated_at_ms as updatedAt, cwd, title, preview, tokens_used as tokensUsed,
            archived, model, source
       from threads
      order by recency_at_ms desc, updated_at_ms desc
      limit 800`
  );

  const fileSummaries = await scanSessionsFallback(paths.sessionsDir);
  const dbSummaries = rows
    .filter((row) => row.filePath && fsSync.existsSync(row.filePath))
    .map(threadRowToSummary);

  const overrides = await readTitleOverrides(targetCodexHome);
  const pinnedIds = await readPinnedSessions(targetCodexHome);
  const archivedIds = await readArchivedSessions(targetCodexHome);
  const applySidecars = (summary) => {
    const custom = overrides[summary.id] || overrides[summary.resumeId];
    return {
      ...summary,
      title: custom || summary.title,
      pinned: isPinnedSession(summary, pinnedIds),
      archived: Boolean(summary.archived) || isArchivedSession(summary, archivedIds)
    };
  };

  if (!dbSummaries.length) return dedupeSessionSummaries(fileSummaries.map(applySidecars));

  const byFile = new Map(fileSummaries.map((summary) => [sessionSummaryKey(summary), summary]));
  for (const dbSummary of dbSummaries) {
    const key = sessionSummaryKey(dbSummary);
    const fileSummary = byFile.get(key);
    byFile.set(key, fileSummary ? mergeSessionSummary(dbSummary, fileSummary) : dbSummary);
  }

  return dedupeSessionSummaries([...byFile.values()].map(applySidecars)).slice(0, 800);
}

async function listSessions() {
  const groups = await Promise.all(codexHomes.map((targetCodexHome) => listSessionsForHome(targetCodexHome)));
  return dedupeSessionSummaries(groups.flat()).slice(0, 800);
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
  const account = await queryAppServerUsage();
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

  const accountDaily = account.usage?.dailyUsageBuckets
    ? account.usage.dailyUsageBuckets.slice(-21).map((bucket) => ({
        date: bucket.startDate,
        sessions: 0,
        tokens: Number(bucket.tokens || 0)
      }))
    : null;

  const liveRateLimits =
    account.rateLimits?.rateLimitsByLimitId?.codex ||
    account.rateLimits?.rateLimits ||
    null;

  return {
    codexHome,
    summary: {
      sessions: Number(summary?.sessions || 0),
      totalTokens:
        account.usage?.summary?.lifetimeTokens == null
          ? Number(summary?.totalTokens || 0)
          : Number(account.usage.summary.lifetimeTokens),
      maxTokens:
        account.usage?.summary?.peakDailyTokens == null
          ? Number(summary?.maxTokens || 0)
          : Number(account.usage.summary.peakDailyTokens),
      lastUpdated: Number(summary?.lastUpdated || 0)
    },
    localSummary: {
      sessions: Number(summary?.sessions || 0),
      totalTokens: Number(summary?.totalTokens || 0),
      maxTokens: Number(summary?.maxTokens || 0),
      lastUpdated: Number(summary?.lastUpdated || 0)
    },
    daily:
      accountDaily ||
      daily.reverse().map((row) => ({
        date: row.date,
        sessions: Number(row.sessions || 0),
        tokens: Number(row.tokens || 0)
      })),
    byWorkspace: byWorkspace.map((row) => ({
      cwd: row.cwd || "",
      sessions: Number(row.sessions || 0),
      tokens: Number(row.tokens || 0)
    })),
    latest: account.available
      ? {
          observedAt: account.observedAt,
          usage: null,
          rateLimits: liveRateLimits,
          filePath: "codex app-server"
        }
      : await findLatestRateLimit(),
    account
  };
}

function summarizeRunRecord(record) {
  const payload = record?.payload ?? {};
  const item = record?.item ?? {};

  if (record?.type === "item.completed") {
    if (item.type === "agent_message" && item.text) {
      return { kind: "message", role: "assistant", phase: null, text: item.text };
    }
    if (item.type === "user_message" && item.text) {
      return { kind: "message", role: "user", phase: null, text: item.text };
    }
    if (item.type === "tool_call") {
      return { kind: "tool", text: `${item.name || "tool"} ${item.arguments || ""}`.trim() };
    }
    if (item.type === "tool_call_output") {
      return { kind: "tool_output", text: truncateText(item.output || "", 4000) };
    }
    if (item.type === "error") {
      return { kind: "event", text: item.message || "error" };
    }
  }

  if (record?.type === "turn.completed") {
    return {
      kind: "usage",
      usage: {
        total: normalizeTokenUsage(record.usage),
        last: normalizeTokenUsage(record.usage),
        modelContextWindow: null
      },
      rateLimits: null
    };
  }

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
  const session = await parseSessionFile(filePath);
  const targetCodexHome = findCodexHomeForSessionPath(filePath);
  if (!targetCodexHome) return { ...session, pinned: false, archived: false };
  const targetPaths = codexHomePaths(targetCodexHome);
  const pinnedIds = await readPinnedSessions(targetCodexHome);
  const archivedIds = await readArchivedSessions(targetCodexHome);
  const rows = await querySqlite(
    targetPaths.stateDb,
    `select archived from threads where id = ${sqlString(session.id)} or rollout_path = ${sqlString(filePath)} limit 1`
  );
  return {
    ...session,
    pinned: isPinnedSession(session, pinnedIds),
    archived: Boolean(rows[0]?.archived) || isArchivedSession(session, archivedIds)
  };
});

ipcMain.handle("sessions:rename", async (_event, id, title) => {
  const sessionId = String(id || "").trim();
  const nextTitle = String(title || "").trim().slice(0, 180);
  if (!sessionId) throw new Error("Session id is empty.");
  if (!nextTitle) throw new Error("Title is empty.");
  const sql = `update threads set title = ${sqlString(nextTitle)} where id = ${sqlString(sessionId)}`;
  await Promise.all(codexHomes.map((targetCodexHome) =>
    execSqlite(codexHomePaths(targetCodexHome).stateDb, sql).catch(() => false)
  ));
  // Persist to the app-owned override store so an active Codex session cannot
  // clobber the custom title on its next turn.
  await Promise.all(codexHomes.map((targetCodexHome) =>
    writeTitleOverride(targetCodexHome, sessionId, nextTitle).catch(() => false)
  ));
  return { id: sessionId, title: nextTitle };
});

ipcMain.handle("sessions:pin", async (_event, id, filePath, pinned) => {
  const sessionId = String(id || "").trim();
  const sourcePath = String(filePath || "").trim();
  if (!sessionId) throw new Error("Session id is empty.");
  if (!sourcePath) throw new Error("Session file path is empty.");
  const targetCodexHome = findCodexHomeForSessionPath(sourcePath);
  if (!targetCodexHome) {
    throw new Error("Refusing to pin a file outside the Codex sessions directory.");
  }
  const resumeId = resumeIdFromPath(sourcePath);
  const nextPinned = Boolean(pinned);
  await writePinnedSession(targetCodexHome, [sessionId, resumeId], nextPinned);
  return { id: sessionId, pinned: nextPinned };
});

ipcMain.handle("sessions:archive", async (_event, id, filePath, archived) => {
  const sessionId = String(id || "").trim();
  const sourcePath = String(filePath || "").trim();
  if (!sessionId) throw new Error("Session id is empty.");
  if (!sourcePath) throw new Error("Session file path is empty.");
  const targetCodexHome = findCodexHomeForSessionPath(sourcePath);
  if (!targetCodexHome) {
    throw new Error("Refusing to archive a file outside the Codex sessions directory.");
  }
  const targetPaths = codexHomePaths(targetCodexHome);
  const resumeId = resumeIdFromPath(sourcePath);
  const nextArchived = Boolean(archived);
  const sql = `update threads set archived = ${nextArchived ? 1 : 0} where id = ${sqlString(sessionId)} or rollout_path = ${sqlString(sourcePath)};`;
  await execSqlite(targetPaths.stateDb, sql).catch(() => false);
  await writeArchivedSession(targetCodexHome, [sessionId, resumeId], nextArchived);
  return { id: sessionId, archived: nextArchived };
});

ipcMain.handle("sessions:delete", async (_event, id, filePath) => {
  const sessionId = String(id || "").trim();
  const sourcePath = String(filePath || "").trim();
  if (!sessionId) throw new Error("Session id is empty.");
  if (!sourcePath) throw new Error("Session file path is empty.");
  const targetCodexHome = findCodexHomeForSessionPath(sourcePath);
  if (!targetCodexHome) {
    throw new Error("Refusing to delete a file outside the Codex sessions directory.");
  }
  const targetPaths = codexHomePaths(targetCodexHome);
  if (!fsSync.existsSync(sourcePath)) {
    throw new Error("Session file was not found.");
  }

  const relativePath = path.relative(targetPaths.sessionsDir, sourcePath);
  const destinationPath = path.join(targetPaths.deletedSessionsDir, timestampPathSegment(), relativePath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rename(sourcePath, destinationPath);

  const sql = `
delete from thread_dynamic_tools where thread_id = ${sqlString(sessionId)};
delete from thread_spawn_edges
 where parent_thread_id = ${sqlString(sessionId)}
    or child_thread_id = ${sqlString(sessionId)};
delete from threads where id = ${sqlString(sessionId)};
`;

  try {
    await execSqlite(targetPaths.stateDb, sql);
  } catch (error) {
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.rename(destinationPath, sourcePath).catch(() => {});
    throw error;
  }

  await removeTitleOverride(targetCodexHome, sessionId).catch(() => {});
  await removePinnedSession(targetCodexHome, sessionId, resumeIdFromPath(sourcePath)).catch(() => {});
  await removeArchivedSession(targetCodexHome, sessionId, resumeIdFromPath(sourcePath)).catch(() => {});
  return { id: sessionId, deletedPath: destinationPath };
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

ipcMain.handle("models:list", () => listModels());

ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  return shell.openPath(targetPath);
});

ipcMain.handle("shell:showItem", (_event, targetPath) => {
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle("codex:run", async (event, options) => {
  const prompt = String(options?.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is empty.");

  const runId = crypto.randomUUID();
  const cwd = options?.cwd || os.homedir();
  const model = await resolveRunModel(options?.model);
  const sessionId = String(options?.sessionId || "").trim();
  if (sessionId) {
    const active = listActiveSessionProcesses(sessionId);
    if (active.length) {
      const pids = active.map((item) => item.pid).join(", ");
      throw new Error(`这个 session 正在被其他 Codex 进程使用（PID ${pids}）。请先退出对应 CLI 窗口，或停止正在运行的桌面任务后再继续。`);
    }
  }
  const args = sessionId
    ? ["exec", "resume", "--json", "--all", "--skip-git-repo-check"]
    : ["exec", "--json", "--color", "never", "-C", cwd, "--skip-git-repo-check"];

  args.push("-m", model);
  if (sessionId) args.push(sessionId, prompt);
  else args.push(prompt);

  const send = (payload) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("codex:run-event", { runId, ...payload });
    }
  };

  setImmediate(() => {
    const child = spawn(codexBinary, args, {
      cwd,
      env: buildCodexEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    runningCodex.set(runId, { child, sessionId });
    send({ kind: "started", args: [codexBinary, ...args] });

    let stdoutBuffer = "";
    let sawAssistantMessage = false;
    let timedOut = false;
    let closed = false;
    let idleTimer = null;
    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (closed) return;
        timedOut = true;
        send({
          kind: "error",
          text: "Codex 已超过 120 秒没有返回有效输出，桌面版已停止这次运行。通常是 Codex CLI 后台刷新模型或远程 MCP 通道卡住，重新发送即可；如果这个 session 同时开在 CLI，请先退出那个 CLI 窗口。"
        });
        killCodexRun(child);
      }, CODEX_RUN_IDLE_TIMEOUT_MS);
    };
    armIdleTimer();

    child.stdout.on("data", (chunk) => {
      armIdleTimer();
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = parseJsonLine(line);
        const summary = record ? summarizeRunRecord(record) : { kind: "stdout", text: line };
        if (summary.kind === "message" && summary.role === "assistant") sawAssistantMessage = true;
        send({
          kind: "record",
          raw: line,
          record: record || null,
          summary
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      send({ kind: "stderr", text: chunk.toString("utf8") });
    });

    child.on("error", (error) => {
      closed = true;
      clearIdleTimer();
      runningCodex.delete(runId);
      send({ kind: "error", text: error.message });
    });

    child.on("close", (code, signal) => {
      closed = true;
      clearIdleTimer();
      runningCodex.delete(runId);
      if (stdoutBuffer.trim()) {
        const record = parseJsonLine(stdoutBuffer.trim());
        const summary = record ? summarizeRunRecord(record) : { kind: "stdout", text: stdoutBuffer.trim() };
        if (summary.kind === "message" && summary.role === "assistant") sawAssistantMessage = true;
        send({
          kind: "record",
          raw: stdoutBuffer.trim(),
          record: record || null,
          summary
        });
      }
      if (!timedOut && code === 0 && !sawAssistantMessage) {
        send({
          kind: "error",
          text: "Codex 进程已结束，但没有收到助手回复。请看上方日志；如果日志包含模型刷新或 MCP 通道错误，直接重新发送通常可以恢复。"
        });
      }
      send({ kind: "done", code, signal });
    });
  });

  return { runId };
});

ipcMain.handle("codex:cancel", (_event, runId) => {
  const run = runningCodex.get(runId);
  if (!run) return false;
  killCodexRun(run.child);
  runningCodex.delete(runId);
  return true;
});
