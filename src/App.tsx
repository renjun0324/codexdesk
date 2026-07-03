import {
  Check,
  Download,
  Edit3,
  ExternalLink,
  FolderOpen,
  MessageSquare,
  Play,
  RefreshCcw,
  Search,
  Settings2,
  Square,
  Trash2,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
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

const numberFormat = new Intl.NumberFormat("zh-CN");
const shortNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1
});
const RAIL_WIDTH_KEY = "codexdesk.sessionRailWidth";
const DEFAULT_RAIL_WIDTH = 330;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 560;

function clampRailWidth(value: number) {
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, value));
}

function readStoredRailWidth() {
  if (typeof window === "undefined") return DEFAULT_RAIL_WIDTH;
  const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
  const parsed = raw ? Number(raw) : DEFAULT_RAIL_WIDTH;
  return Number.isFinite(parsed) ? clampRailWidth(parsed) : DEFAULT_RAIL_WIDTH;
}

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

function formatModelName(model?: string | null) {
  if (!model) return "";
  if (model === "gpt-5-codex") return "GPT-5 / Codex";
  if (model === "gpt-5") return "GPT-5";
  return model;
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

function createLiveMessage(role: SessionMessage["role"], text: string, phase: string | null): SessionMessage {
  return {
    kind: "message",
    id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    phase,
    timestamp: new Date().toISOString(),
    text
  };
}

function appendLiveMessage(current: SessionMessage[], next: SessionMessage) {
  const previous = current[current.length - 1];
  if (
    previous &&
    previous.role === "assistant" &&
    next.role === "assistant" &&
    previous.phase === next.phase &&
    (next.phase === "commentary" || next.phase === "live")
  ) {
    return [
      ...current.slice(0, -1),
      {
        ...previous,
        id: `${previous.id}+${next.id}`,
        timestamp: next.timestamp || previous.timestamp,
        text: `${previous.text.trim()}\n\n${next.text.trim()}`.trim()
      }
    ];
  }
  return [...current, next];
}

function SessionList({
  sessions,
  selected,
  query,
  showArchived,
  onQuery,
  onToggleArchived,
  onSelect,
  onRename,
  onDelete,
  onRefresh
}: {
  sessions: SessionSummary[];
  selected: string | null;
  query: string;
  showArchived: boolean;
  onQuery: (value: string) => void;
  onToggleArchived: (value: boolean) => void;
  onSelect: (session: SessionSummary) => void;
  onRename: (session: SessionSummary, title: string) => Promise<void>;
  onDelete: (session: SessionSummary) => Promise<void>;
  onRefresh: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const beginRename = (session: SessionSummary) => {
    setEditingId(session.id);
    setDraftTitle(session.title);
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraftTitle("");
  };

  const saveRename = async (session: SessionSummary) => {
    const title = draftTitle.trim();
    if (!title || savingId) return;
    setSavingId(session.id);
    try {
      await onRename(session, title);
      cancelRename();
    } finally {
      setSavingId(null);
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    if (deletingId) return;
    setDeletingId(session.id);
    try {
      await onDelete(session);
    } finally {
      setDeletingId(null);
    }
  };

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
        <span>显示归档</span>
      </label>
      <div className="session-count">{filtered.length} / {sessions.length}</div>
      <div className="session-list">
        {filtered.map((session) => {
          const editing = editingId === session.id;
          return (
            <article className={`session-item ${selected === session.id ? "active" : ""}`} key={session.id}>
              {editing ? (
                <div className="rename-editor">
                  <input
                    autoFocus
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveRename(session);
                      if (event.key === "Escape") cancelRename();
                    }}
                  />
                  <button
                    className="rename-action"
                    type="button"
                    title="保存"
                    onClick={() => void saveRename(session)}
                    disabled={savingId === session.id || !draftTitle.trim()}
                  >
                    <Check size={15} />
                  </button>
                  <button className="rename-action" type="button" title="取消" onClick={cancelRename}>
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <button className="session-main" type="button" onClick={() => onSelect(session)}>
                    <span className="session-title" title={session.title}>{session.title}</span>
                    {session.cwd ? (
                      <span className="session-workdir" title={session.cwd}>
                        <FolderOpen size={12} />
                        <span>{basename(session.cwd)}</span>
                      </span>
                    ) : null}
                    <span className="session-preview" title={session.preview || session.cwd}>
                      {session.preview || session.cwd}
                    </span>
                    <span className="session-meta">
                      <span>{formatDate(session.updatedAt)}</span>
                      <span>{formatShort(session.tokensUsed)}</span>
                    </span>
                  </button>
                  <button
                    className="rename-button"
                    type="button"
                    title="重命名"
                    onClick={() => beginRename(session)}
                  >
                    <Edit3 size={15} />
                  </button>
                  <button
                    className="delete-button"
                    type="button"
                    title="删除"
                    onClick={() => void deleteSession(session)}
                    disabled={deletingId === session.id}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </article>
          );
        })}
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
  const [liveMessages, setLiveMessages] = useState<SessionMessage[]>([]);
  const [runStatus, setRunStatus] = useState("");
  const scrollRef = useRef<HTMLElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLiveMessages([]);
    setRunStatus("");
  }, [selected?.id]);

  const messages = useMemo(() => {
    const savedMessages = session?.messages || [];
    const pendingMessages = liveMessages.filter(
      (live) => !savedMessages.some((saved) => saved.role === live.role && saved.text === live.text)
    );
    return [...savedMessages, ...pendingMessages];
  }, [liveMessages, session?.messages]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) {
        node.scrollTo({ top: node.scrollHeight, behavior });
        return;
      }
      bottomRef.current?.scrollIntoView({ block: "end", behavior });
    });
  }, []);

  useEffect(() => {
    scrollToLatest("smooth");
  }, [messages.length, runStatus, scrollToLatest, selected?.id, session?.updatedAt]);

  const handleRunStart = useCallback((text: string) => {
    setLiveMessages((current) => [...current, createLiveMessage("user", text, "sent")]);
    setRunStatus("正在等待 Codex 回答");
  }, []);

  const handleRunEvent = useCallback((event: CodexRunEvent) => {
    if (event.kind === "started") {
      setRunStatus("Codex 正在运行");
      return;
    }
    if (event.kind === "record") {
      const summary = event.summary;
      if (summary.kind === "message" && summary.role === "assistant") {
        setLiveMessages((current) =>
          appendLiveMessage(current, createLiveMessage("assistant", summary.text, summary.phase || "live"))
        );
        setRunStatus("正在接收回答");
      }
      if (summary.kind === "usage") {
        setRunStatus(`已使用 ${formatShort(summary.usage?.total?.totalTokens || 0)} tokens`);
      }
      return;
    }
    if (event.kind === "stderr" || event.kind === "error") {
      setLiveMessages((current) => appendLiveMessage(current, createLiveMessage("assistant", event.text, "error")));
      setRunStatus("运行失败");
      return;
    }
    if (event.kind === "done") {
      setRunStatus(event.code && event.code !== 0 ? `退出码 ${event.code}` : "已完成，正在刷新会话");
    }
  }, []);

  if (loading) return <main className="content-pane loading-pane">Loading...</main>;
  if (!session) {
    return (
      <main className="content-pane thread-pane">
        <section className="thread-scroll" ref={scrollRef}>
          {messages.length ? (
            <section className="messages live-messages">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {runStatus ? <div className="thread-run-status">{runStatus}</div> : null}
              <div ref={bottomRef} />
            </section>
          ) : (
            <div className="empty-state empty-thread">
              <MessageSquare size={28} />
              <strong>{selected ? selected.title : "No session"}</strong>
            </div>
          )}
        </section>
        <ThreadComposer selected={selected} onStart={handleRunStart} onEvent={handleRunEvent} onDone={onRunDone} />
      </main>
    );
  }

  return (
    <main className="content-pane thread-pane">
      <section className="thread-scroll" ref={scrollRef}>
        <section className="session-header">
          <div>
            <p className="eyebrow">{session.model || session.source || "codex"}</p>
            <h1>{selected?.title || session.title}</h1>
            <div className="path-line" title={session.cwd || session.filePath}>
              {session.cwd || basename(session.filePath)}
            </div>
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
          <Metric label="messages" value={messages.length} />
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
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {runStatus ? <div className="thread-run-status">{runStatus}</div> : null}
          <div ref={bottomRef} />
        </section>
      </section>
      <ThreadComposer selected={selected} onStart={handleRunStart} onEvent={handleRunEvent} onDone={onRunDone} />
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

function UsageMiniPanel({
  usage,
  loading,
  onRefresh
}: {
  usage: UsageSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const primary = usage?.latest?.rateLimits?.primary || null;
  const secondary = usage?.latest?.rateLimits?.secondary || null;
  const usedPercent = Math.max(0, Math.min(100, primary?.usedPercent || 0));
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const reset = primary?.resetsAt ? formatFullDate(primary.resetsAt * 1000) : "-";
  const observedAt = usage?.latest?.observedAt || usage?.account.observedAt || usage?.summary.lastUpdated || null;
  const sourceLabel = usage?.account.available ? "Codex 实时限额" : "本地记录估算";

  return (
    <aside className="usage-mini" aria-label="usage">
      <div className="usage-mini-top">
        <div>
          <h2>限额</h2>
          <span>{sourceLabel}</span>
        </div>
        <button className="icon-button" type="button" title="刷新" onClick={onRefresh}>
          <RefreshCcw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <section className="usage-mini-metrics">
        <Metric label="当前窗口已用" value={`${usedPercent.toFixed(1)}%`} />
        <Metric label="剩余估算" value={`${remainingPercent.toFixed(1)}%`} />
        <div className="metric usage-reset">
          <span>重置时间</span>
          <strong>{reset}</strong>
        </div>
      </section>

      {primary ? (
        <div className="usage-mini-usage">
          <div className="rate-row">
            <div className="rate-meta">
              <span>短窗口</span>
              <strong>{usedPercent.toFixed(1)}%</strong>
            </div>
            <div className="meter" aria-label="primary rate limit used">
              <div style={{ width: `${usedPercent}%` }} />
            </div>
            <div className="muted micro">
              {primary.windowMinutes ? `${primary.windowMinutes} 分钟窗口` : "窗口 -"}
            </div>
          </div>
          {secondary ? <RateBar label="长窗口" value={secondary} /> : null}
        </div>
      ) : null}

      <div className="muted usage-mini-meta">
        <span className="status-dot live" />
        <span>最近刷新：{formatFullDate(observedAt)}</span>
      </div>
    </aside>
  );
}

function ThreadComposer({
  selected,
  onStart,
  onEvent,
  onDone
}: {
  selected: SessionSummary | null;
  onStart: (prompt: string) => void;
  onEvent: (event: CodexRunEvent) => void;
  onDone: () => void;
}) {
  const [cwd, setCwd] = useState(selected?.cwd || "");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [statusText, setStatusText] = useState("Ready");

  useEffect(() => {
    if (selected?.cwd) setCwd(selected.cwd);
    setModel("");
  }, [selected?.cwd, selected?.id]);

  useEffect(() => {
    return window.codexDesk.onCodexEvent((event) => {
      onEvent(event);
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
  }, [onDone, onEvent]);

  const start = async () => {
    const text = prompt.trim();
    if (!text || runId || starting) return;
    const targetSessionId = selected?.id || undefined;
    setStarting(true);
    setStatusText(targetSessionId ? "Starting current session" : "Starting new session");
    onStart(text);
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
      onEvent({
        runId: "local",
        kind: "error",
        text: error instanceof Error ? error.message : String(error)
      });
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
  const currentPlace = selected ? "当前会话" : "新会话";
  const inheritedModelLabel = selected?.model
    ? `跟随当前会话（${formatModelName(selected.model)}）`
    : "跟随 Codex 默认模型";
  const modelOptions = [
    { value: "gpt-5-codex", label: "GPT-5 / Codex" },
    { value: "gpt-5", label: "GPT-5" }
  ];
  const knownModelValues = modelOptions.map((option) => option.value);
  const customSessionModel = selected?.model && !knownModelValues.includes(selected.model) ? selected.model : null;

  return (
    <section className="thread-composer" aria-label="Codex composer">
      <div className="composer-shell">
        <textarea
          className="prompt-box"
          lang="zh-CN"
          spellCheck={false}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(event) => {
            setIsComposing(false);
            setPrompt(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isComposing || event.nativeEvent.isComposing || event.key === "Process") return;
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void start();
            }
          }}
          placeholder={selected ? "继续当前 session" : "新建 session"}
        />

        <div className="composer-toolbar">
          <div className="composer-left">
            <span className="target-pill" title={selected?.id || "new session"}>
              {currentPlace}
            </span>
            <span className="composer-status">{statusText}</span>
          </div>

          <div className="composer-right">
            <button
              className={`settings-button ${showSettings ? "active" : ""}`}
              type="button"
              title="运行设置"
              onClick={() => setShowSettings((value) => !value)}
            >
              <Settings2 size={16} />
              运行设置
            </button>
            <button className="send-button run" type="button" title="发送" onClick={start} disabled={!canSend}>
              <Play size={18} />
              发送
            </button>
            <button className="icon-button stop" type="button" title="停止" onClick={cancel} disabled={!runId}>
              <Square size={16} />
            </button>
          </div>
        </div>

        {showSettings ? (
          <section className="composer-settings">
            <label className="setting-field">
              <span>模型</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">{inheritedModelLabel}</option>
                {customSessionModel ? (
                  <option value={customSessionModel}>{formatModelName(customSessionModel)}</option>
                ) : null}
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small>不选择时不覆盖 CLI 的 session 模型。</small>
            </label>
            <label className="setting-field wide">
              <span>工作目录</span>
              <input
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={selected?.cwd || "工作目录"}
                title="工作目录"
              />
            </label>
            <button
              className="open-dir-button"
              type="button"
              title="打开工作目录"
              onClick={() => composerCwd && window.codexDesk.openPath(composerCwd)}
              disabled={!composerCwd}
            >
              <FolderOpen size={16} />
              打开目录
            </button>
          </section>
        ) : null}
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
  const [railWidth, setRailWidth] = useState(readStoredRailWidth);

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

  const renameSession = useCallback(async (session: SessionSummary, title: string) => {
    const result = await window.codexDesk.renameSession(session.id, title);
    setSessions((current) =>
      current.map((item) => (item.id === result.id ? { ...item, title: result.title } : item))
    );
    setSelected((current) => (current?.id === result.id ? { ...current, title: result.title } : current));
  }, []);

  const deleteSession = useCallback(async (session: SessionSummary) => {
    const confirmed = window.confirm(`删除这个 session？\n\n${session.title}\n\nJSONL 会移到 deleted_sessions，可手动恢复。`);
    if (!confirmed) return;

    try {
      await window.codexDesk.deleteSession(session.id, session.filePath);
      const index = sessions.findIndex((item) => item.id === session.id);
      const nextSessions = sessions.filter((item) => item.id !== session.id);
      const replacement = nextSessions[index] || nextSessions[index - 1] || nextSessions[0] || null;
      setSessions(nextSessions);
      setSelected((current) => (current?.id === session.id ? replacement : current));
      setDetail((current) => (current?.id === session.id ? null : current));
      void refreshUsage();
      setToast(`已删除 ${session.title}`);
      window.setTimeout(() => setToast(null), 2600);
    } catch (error) {
      setToast(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      window.setTimeout(() => setToast(null), 3600);
    }
  }, [refreshUsage, sessions]);

  const startRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth;
    let nextWidth = startWidth;

    const handleMove = (moveEvent: PointerEvent) => {
      nextWidth = clampRailWidth(startWidth + moveEvent.clientX - startX);
      setRailWidth(nextWidth);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.classList.remove("resizing-rail");
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(nextWidth));
    };

    document.body.classList.add("resizing-rail");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, [railWidth]);

  const workspaceStyle = {
    gridTemplateColumns: `${railWidth}px 8px minmax(0, 1fr) 320px`
  } satisfies CSSProperties;

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
            <strong>Codex Desk</strong>
            <small>Linux desktop</small>
          </div>
        </div>
        <div className="tabs">
          <MessageSquare size={16} />
          会话
        </div>
        <button
          className="link-button"
          type="button"
          onClick={() => selected && window.codexDesk.openPath(selected.cwd)}
          disabled={!selected?.cwd}
        >
          <ExternalLink size={16} />
          工作目录
        </button>
      </nav>

      <div className="workspace" style={workspaceStyle}>
        <SessionList
          sessions={sessions}
          selected={selected?.id || null}
          query={query}
          showArchived={showArchived}
          onQuery={setQuery}
          onToggleArchived={setShowArchived}
          onRefresh={refreshSessions}
          onRename={renameSession}
          onDelete={deleteSession}
          onSelect={(session) => {
            setSelected(session);
          }}
        />
        <div
          className="rail-resizer"
          role="separator"
          aria-label="调整会话列表宽度"
          aria-orientation="vertical"
          onPointerDown={startRailResize}
        />

        <SessionPane
          session={detail}
          selected={selected}
          loading={loadingSession}
          onExport={exportCurrent}
          onShowFile={showFile}
          onRunDone={handleRunDone}
        />
        <UsageMiniPanel usage={usage} loading={loadingUsage} onRefresh={refreshUsage} />
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
