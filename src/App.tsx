import {
  BarChart3,
  Download,
  ExternalLink,
  FolderOpen,
  MessageSquare,
  Play,
  RefreshCcw,
  Search,
  Square,
  Terminal
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type {
  CodexRunEvent,
  RateLimitWindow,
  SessionDetail,
  SessionMessage,
  SessionSummary,
  TokenBreakdown,
  UsageSnapshot
} from "./types";

type Tab = "thread" | "usage";

const numberFormat = new Intl.NumberFormat("zh-CN");
const shortNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1
});

function formatNumber(value?: number | null) {
  return numberFormat.format(value || 0);
}

function formatShort(value?: number | null) {
  return shortNumber.format(value || 0);
}

function formatDate(value?: number | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatFullDate(value?: number | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN");
}

function basename(filePath: string) {
  return filePath.split("/").filter(Boolean).pop() || filePath;
}

function RateBar({ label, value }: { label: string; value: RateLimitWindow | null }) {
  const percent = Math.max(0, Math.min(100, value?.usedPercent || 0));
  return (
    <div className="rate-row">
      <div className="rate-meta">
        <span>{label}</span>
        <strong>{percent.toFixed(1)}%</strong>
      </div>
      <div className="meter" aria-label={`${label} ${percent}%`}>
        <div style={{ width: `${percent}%` }} />
      </div>
      <div className="muted micro">
        {value?.windowMinutes ? `${value.windowMinutes} min` : "window -"}
        {value?.resetsAt ? ` / reset ${formatFullDate(value.resetsAt * 1000)}` : ""}
      </div>
    </div>
  );
}

function TokenGrid({ usage }: { usage: TokenBreakdown | null | undefined }) {
  return (
    <div className="token-grid">
      <Metric label="total" value={usage?.totalTokens || 0} />
      <Metric label="input" value={usage?.inputTokens || 0} />
      <Metric label="cached" value={usage?.cachedInputTokens || 0} />
      <Metric label="output" value={usage?.outputTokens || 0} />
      <Metric label="reasoning" value={usage?.reasoningOutputTokens || 0} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{typeof value === "number" ? formatShort(value) : value}</strong>
    </div>
  );
}

function MarkdownBlock({ text }: { text: string }) {
  const safeText = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code({ className, children }) {
          const inline = !className;
          if (inline) return <code>{children}</code>;
          return <code className={className}>{children}</code>;
        },
        a({ children, href }) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
      }}
    >
      {safeText}
    </ReactMarkdown>
  );
}

function MessageBubble({ message }: { message: SessionMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <header>
        <span>{message.role === "user" ? "User" : "Codex"}</span>
        {message.phase ? <em>{message.phase}</em> : null}
      </header>
      <div className="markdown-body">
        <MarkdownBlock text={message.text} />
      </div>
    </article>
  );
}

function SessionList({
  sessions,
  selected,
  query,
  showArchived,
  onQuery,
  onToggleArchived,
  onSelect,
  onRefresh
}: {
  sessions: SessionSummary[];
  selected: string | null;
  query: string;
  showArchived: boolean;
  onQuery: (value: string) => void;
  onToggleArchived: (value: boolean) => void;
  onSelect: (session: SessionSummary) => void;
  onRefresh: () => void;
}) {
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (!showArchived && session.archived) return false;
      if (!needle) return true;
      return `${session.title} ${session.preview} ${session.cwd} ${session.model}`
        .toLowerCase()
        .includes(needle);
    });
  }, [query, sessions, showArchived]);

  return (
    <aside className="session-rail">
      <div className="rail-top">
        <div className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索" />
        </div>
        <button className="icon-button" type="button" title="刷新" onClick={onRefresh}>
          <RefreshCcw size={17} />
        </button>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => onToggleArchived(event.target.checked)}
        />
        <span>Archived</span>
      </label>
      <div className="session-count">{filtered.length} / {sessions.length}</div>
      <div className="session-list">
        {filtered.map((session) => (
          <button
            className={`session-item ${selected === session.id ? "active" : ""}`}
            key={session.id}
            type="button"
            onClick={() => onSelect(session)}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-preview">{session.preview || session.cwd}</span>
            <span className="session-meta">
              <span>{formatDate(session.updatedAt)}</span>
              <span>{formatShort(session.tokensUsed)}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function SessionPane({
  session,
  selected,
  loading,
  onExport,
  onShowFile,
  onRunDone
}: {
  session: SessionDetail | null;
  selected: SessionSummary | null;
  loading: boolean;
  onExport: () => void;
  onShowFile: () => void;
  onRunDone: () => void;
}) {
  if (loading) return <main className="content-pane loading-pane">Loading...</main>;
  if (!session) {
    return (
      <main className="content-pane thread-pane">
        <section className="thread-scroll empty-thread">
          <div className="empty-state">
            <MessageSquare size={28} />
            <strong>{selected ? selected.title : "No session"}</strong>
          </div>
        </section>
        <ThreadComposer selected={selected} onDone={onRunDone} />
      </main>
    );
  }

  return (
    <main className="content-pane thread-pane">
      <section className="thread-scroll">
        <section className="session-header">
          <div>
            <p className="eyebrow">{session.model || session.source || "codex"}</p>
            <h1>{session.title}</h1>
            <div className="path-line">{session.cwd || basename(session.filePath)}</div>
          </div>
          <div className="header-actions">
            <button className="icon-button" type="button" title="导出 Markdown" onClick={onExport}>
              <Download size={18} />
            </button>
            <button className="icon-button" type="button" title="定位 JSONL" onClick={onShowFile}>
              <FolderOpen size={18} />
            </button>
          </div>
        </section>

        <section className="session-stats">
          <Metric label="messages" value={session.messages.length} />
          <Metric label="tools" value={session.events.length} />
          <Metric label="tokens" value={session.tokenUsage?.total?.totalTokens || 0} />
          <Metric label="updated" value={formatDate(session.updatedAt)} />
        </section>

        {session.rateLimits ? (
          <section className="inline-usage">
            <RateBar label="primary" value={session.rateLimits.primary} />
            <RateBar label="secondary" value={session.rateLimits.secondary} />
          </section>
        ) : null}

        <section className="messages">
          {session.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </section>

        {session.events.length ? (
          <section className="tool-section">
            <h2>Tool Events</h2>
            {session.events.map((event) => (
              <details key={event.id}>
                <summary>
                  {event.kind} / {event.name}
                </summary>
                <pre>{event.text}</pre>
              </details>
            ))}
          </section>
        ) : null}
      </section>
      <ThreadComposer selected={selected} onDone={onRunDone} />
    </main>
  );
}

function UsagePane({
  usage,
  loading,
  onRefresh
}: {
  usage: UsageSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const maxDaily = Math.max(...(usage?.daily.map((item) => item.tokens) || [1]), 1);
  const accountSummary = usage?.account.usage?.summary || null;
  const isLive = Boolean(usage?.account.available);

  return (
    <main className="content-pane usage-pane">
      <section className="session-header compact">
        <div>
          <p className="eyebrow">usage</p>
          <h1>流量</h1>
          <div className="path-line">{usage?.codexHome || "~/.codex"}</div>
        </div>
        <button className="icon-button" type="button" title="刷新" onClick={onRefresh}>
          <RefreshCcw size={18} className={loading ? "spin" : ""} />
        </button>
      </section>

      <section className="session-stats">
        <Metric label="account" value={usage?.summary.totalTokens || 0} />
        <Metric label="peak day" value={usage?.summary.maxTokens || 0} />
        <Metric label="local sessions" value={usage?.localSummary.sessions || 0} />
        <Metric label="local sum" value={usage?.localSummary.totalTokens || 0} />
      </section>

      <section className="usage-source">
        <span className={isLive ? "status-dot live" : "status-dot"} />
        <span>
          {isLive
            ? `live account data from ${usage?.account.codexBinary || "codex app-server"}`
            : `fallback from local session logs${usage?.account.error ? `: ${usage.account.error}` : ""}`}
        </span>
        <Metric label="updated" value={formatDate(usage?.summary.lastUpdated)} />
      </section>

      <section className="usage-block">
        <h2>Rate Limits</h2>
        <RateBar label="primary" value={usage?.latest?.rateLimits?.primary || null} />
        <RateBar label="secondary" value={usage?.latest?.rateLimits?.secondary || null} />
        <div className="micro muted">
          {usage?.latest?.observedAt ? `observed ${formatFullDate(usage.latest.observedAt)}` : "-"}
        </div>
      </section>

      <section className="usage-block">
        <h2>{accountSummary ? "Account Summary" : "Latest Token Count"}</h2>
        {accountSummary ? (
          <div className="token-grid">
            <Metric label="lifetime" value={accountSummary.lifetimeTokens || 0} />
            <Metric label="peak day" value={accountSummary.peakDailyTokens || 0} />
            <Metric label="streak" value={accountSummary.currentStreakDays || 0} />
            <Metric label="best streak" value={accountSummary.longestStreakDays || 0} />
            <Metric
              label="longest turn"
              value={
                accountSummary.longestRunningTurnSec == null
                  ? "-"
                  : `${accountSummary.longestRunningTurnSec}s`
              }
            />
          </div>
        ) : (
          <TokenGrid usage={usage?.latest?.usage?.total || null} />
        )}
      </section>

      <section className="usage-block">
        <h2>Daily</h2>
        <div className="bar-list">
          {usage?.daily.map((item) => (
            <div className="bar-row" key={item.date}>
              <span>{item.date.slice(5)}</span>
              <div className="bar-track">
                <div style={{ width: `${Math.max(2, (item.tokens / maxDaily) * 100)}%` }} />
              </div>
              <strong>{formatShort(item.tokens)}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="usage-block">
        <h2>Workspaces</h2>
        <div className="workspace-list">
          {usage?.byWorkspace.map((item) => (
            <div className="workspace-row" key={item.cwd}>
              <span title={item.cwd}>{item.cwd || "-"}</span>
              <strong>{formatShort(item.tokens)}</strong>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function ThreadComposer({
  selected,
  onDone
}: {
  selected: SessionSummary | null;
  onDone: () => void;
}) {
  const [cwd, setCwd] = useState(selected?.cwd || "");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [statusText, setStatusText] = useState("Ready");
  const [events, setEvents] = useState<CodexRunEvent[]>([]);

  useEffect(() => {
    if (selected?.cwd) setCwd(selected.cwd);
  }, [selected?.cwd, selected?.id]);

  useEffect(() => {
    return window.codexDesk.onCodexEvent((event) => {
      setEvents((current) => [...current, event]);
      if (event.kind === "started") {
        setStatusText("Running");
      }
      if (event.kind === "done" || event.kind === "error") {
        setRunId(null);
        setStarting(false);
        setStatusText(
          event.kind === "error"
            ? "Failed"
            : event.code && event.code !== 0
              ? `Exited ${event.code}`
              : "Done"
        );
        onDone();
      }
    });
  }, [onDone]);

  const start = async () => {
    const text = prompt.trim();
    if (!text || runId || starting) return;
    const targetSessionId = selected?.id || undefined;
    setEvents([]);
    setStarting(true);
    setStatusText(targetSessionId ? "Starting current session" : "Starting new session");
    try {
      const result = await window.codexDesk.runCodex({
        prompt: text,
        cwd: cwd || selected?.cwd || undefined,
        model: model || undefined,
        sessionId: targetSessionId
      });
      setPrompt("");
      setRunId(result.runId);
      setStatusText("Running");
    } catch (error) {
      setStarting(false);
      setStatusText("Failed");
      setEvents([
        {
          runId: "local",
          kind: "error",
          text: error instanceof Error ? error.message : String(error)
        }
      ]);
    }
  };

  const cancel = async () => {
    if (!runId) return;
    await window.codexDesk.cancelRun(runId);
    setRunId(null);
    setStarting(false);
    setStatusText("Stopped");
  };
  const composerCwd = cwd || selected?.cwd || "";
  const canSend = Boolean(prompt.trim()) && !runId && !starting;

  return (
    <section className="thread-composer" aria-label="Codex composer">
      {events.length ? (
        <section className="run-output compact">
          {events.map((event, index) => (
            <RunEventLine key={`${event.runId}-${index}`} event={event} />
          ))}
        </section>
      ) : null}

      <div className="composer-shell">
        <textarea
          className="prompt-box"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void start();
            }
          }}
          placeholder="Ask Codex anything"
        />

        <div className="composer-toolbar">
          <div className="composer-left">
            <button
              className="icon-button ghost"
              type="button"
              title="打开工作目录"
              onClick={() => composerCwd && window.codexDesk.openPath(composerCwd)}
              disabled={!composerCwd}
            >
              <FolderOpen size={16} />
            </button>
            <span className="menu-pill">
              <Terminal size={15} />
              Codex exec
            </span>
            <span className="target-pill" title={selected?.id || "new session"}>
              {selected ? "当前会话" : "新会话"}
            </span>
            <span className="composer-status">{statusText}</span>
          </div>

          <div className="composer-right">
            <input
              className="mini-input cwd-field"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder={selected?.cwd || "cwd"}
              title="cwd"
            />
            <input
              className="mini-input model-field"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={selected?.model || "model"}
              title="model"
            />
            <button className="icon-button run" type="button" title="发送" onClick={start} disabled={!canSend}>
              <Play size={18} />
            </button>
            <button className="icon-button stop" type="button" title="停止" onClick={cancel} disabled={!runId}>
              <Square size={16} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function RunEventLine({ event }: { event: CodexRunEvent }) {
  if (event.kind === "started") {
    return <div className="run-line event">$ {event.args.join(" ")}</div>;
  }
  if (event.kind === "stderr" || event.kind === "error") {
    return <pre className="run-line error">{event.text}</pre>;
  }
  if (event.kind === "done") {
    return <div className="run-line event">done code={event.code ?? "-"} signal={event.signal ?? "-"}</div>;
  }

  const summary = event.summary;
  if (summary.kind === "message") {
    return (
      <article className={`run-message ${summary.role}`}>
        <header>{summary.role === "user" ? "User" : "Codex"}</header>
        <MarkdownBlock text={summary.text} />
      </article>
    );
  }
  if (summary.kind === "usage") {
    return <div className="run-line usage">tokens {formatShort(summary.usage?.total?.totalTokens || 0)}</div>;
  }
  return <pre className={`run-line ${summary.kind}`}>{summary.text}</pre>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("thread");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionReloadKey, setSessionReloadKey] = useState(0);

  const refreshSessions = useCallback(async () => {
    const next = await window.codexDesk.listSessions();
    setSessions(next);
    setSelected((current) => {
      if (!current) return next[0] || null;
      return next.find((session) => session.id === current.id) || current;
    });
  }, []);

  const refreshUsage = useCallback(async () => {
    setLoadingUsage(true);
    try {
      setUsage(await window.codexDesk.getUsage());
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    refreshUsage();
  }, [refreshSessions, refreshUsage]);

  const selectedFilePath = selected?.filePath || null;
  useEffect(() => {
    if (!selectedFilePath) {
      setDetail(null);
      return;
    }
    let active = true;
    setLoadingSession(true);
    window.codexDesk
      .readSession(selectedFilePath)
      .then((next) => {
        if (active) setDetail(next);
      })
      .finally(() => {
        if (active) setLoadingSession(false);
      });
    return () => {
      active = false;
    };
  }, [selectedFilePath, sessionReloadKey]);

  const handleRunDone = useCallback(() => {
    void Promise.all([refreshSessions(), refreshUsage()]).finally(() => {
      setSessionReloadKey((value) => value + 1);
    });
  }, [refreshSessions, refreshUsage]);

  const exportCurrent = async () => {
    if (!selected) return;
    const result = await window.codexDesk.exportSession(selected.filePath);
    if (!result.canceled && result.filePath) {
      setToast(`已导出 ${basename(result.filePath)}`);
      window.setTimeout(() => setToast(null), 2600);
    }
  };

  const showFile = async () => {
    if (selected) await window.codexDesk.showItem(selected.filePath);
  };

  return (
    <div className="app-shell">
      <nav className="topbar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>Codexs Max</strong>
            <small>Linux desktop</small>
          </div>
        </div>
        <div className="tabs">
          <button className={tab === "thread" ? "active" : ""} type="button" onClick={() => setTab("thread")}>
            <MessageSquare size={16} />
            会话
          </button>
          <button className={tab === "usage" ? "active" : ""} type="button" onClick={() => setTab("usage")}>
            <BarChart3 size={16} />
            用量
          </button>
        </div>
        <button
          className="link-button"
          type="button"
          onClick={() => selected && window.codexDesk.openPath(selected.cwd)}
          disabled={!selected?.cwd}
        >
          <ExternalLink size={16} />
          CWD
        </button>
      </nav>

      <div className="workspace">
        <SessionList
          sessions={sessions}
          selected={selected?.id || null}
          query={query}
          showArchived={showArchived}
          onQuery={setQuery}
          onToggleArchived={setShowArchived}
          onRefresh={refreshSessions}
          onSelect={(session) => {
            setSelected(session);
            setTab("thread");
          }}
        />

        {tab === "thread" ? (
          <SessionPane
            session={detail}
            selected={selected}
            loading={loadingSession}
            onExport={exportCurrent}
            onShowFile={showFile}
            onRunDone={handleRunDone}
          />
        ) : null}
        {tab === "usage" ? (
          <UsagePane usage={usage} loading={loadingUsage} onRefresh={refreshUsage} />
        ) : null}
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
