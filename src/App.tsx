import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FolderOpen,
  MessageSquare,
  Moon,
  Pin,
  Plus,
  Play,
  RefreshCcw,
  Search,
  Square,
  Sun,
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
  CodexModel,
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
const THEME_KEY = "codexdesk.theme";
const MODEL_KEY = "codexdesk.model";
const DEFAULT_RAIL_WIDTH = 330;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 560;
const codexDeskIcon = new URL("../assets/codexdesk.svg", import.meta.url).href;
type ThemeMode = "light" | "dark";
const DEFAULT_DESK_MODEL = "gpt-5.5";
const FALLBACK_MODEL_OPTIONS: CodexModel[] = [
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5-codex", name: "GPT-5 / Codex" },
  { id: "gpt-5", name: "GPT-5" }
];

function clampRailWidth(value: number) {
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, value));
}

function readStoredRailWidth() {
  if (typeof window === "undefined") return DEFAULT_RAIL_WIDTH;
  const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
  const parsed = raw ? Number(raw) : DEFAULT_RAIL_WIDTH;
  return Number.isFinite(parsed) ? clampRailWidth(parsed) : DEFAULT_RAIL_WIDTH;
}

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredModel() {
  if (typeof window === "undefined") return DEFAULT_DESK_MODEL;
  return window.localStorage.getItem(MODEL_KEY) || DEFAULT_DESK_MODEL;
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

function sortSessions(sessions: SessionSummary[]) {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

async function copyText(text: string) {
  const value = text.trim();
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to textarea selection below.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function formatModelName(model?: string | null) {
  if (!model) return "";
  if (model === "gpt-5.5") return "GPT-5.5";
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
        {value?.windowMinutes ? `${value.windowMinutes} 分钟窗口` : "窗口 -"}
        {value?.resetsAt ? ` / 重置 ${formatFullDate(value.resetsAt * 1000)}` : ""}
      </div>
    </div>
  );
}

function TokenGrid({ usage }: { usage: TokenBreakdown | null | undefined }) {
  return (
    <div className="token-grid">
      <Metric label="总计" value={usage?.totalTokens || 0} />
      <Metric label="输入" value={usage?.inputTokens || 0} />
      <Metric label="缓存" value={usage?.cachedInputTokens || 0} />
      <Metric label="输出" value={usage?.outputTokens || 0} />
      <Metric label="推理" value={usage?.reasoningOutputTokens || 0} />
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
        <span>{message.role === "user" ? "用户" : "Codex"}</span>
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
  onTogglePinned,
  onToggleSessionArchived,
  onDelete,
  onRefresh,
  refreshing
}: {
  sessions: SessionSummary[];
  selected: string | null;
  query: string;
  showArchived: boolean;
  onQuery: (value: string) => void;
  onToggleArchived: (value: boolean) => void;
  onSelect: (session: SessionSummary) => void;
  onRename: (session: SessionSummary, title: string) => Promise<void>;
  onTogglePinned: (session: SessionSummary, pinned: boolean) => Promise<void>;
  onToggleSessionArchived: (session: SessionSummary, archived: boolean) => Promise<void>;
  onDelete: (session: SessionSummary) => Promise<void>;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sortSessions(sessions.filter((session) => {
      if (!showArchived && session.archived) return false;
      if (!needle) return true;
      return `${session.id} ${session.resumeId} ${session.title} ${session.preview} ${session.cwd} ${session.model}`
        .toLowerCase()
        .includes(needle);
    }));
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

  const togglePinned = async (session: SessionSummary) => {
    if (pinningId) return;
    setPinningId(session.id);
    try {
      await onTogglePinned(session, !session.pinned);
    } finally {
      setPinningId(null);
    }
  };

  const toggleArchived = async (session: SessionSummary) => {
    if (archivingId) return;
    setArchivingId(session.id);
    try {
      await onToggleSessionArchived(session, !session.archived);
    } finally {
      setArchivingId(null);
    }
  };

  return (
    <aside className="session-rail">
      <div className="rail-top">
        <div className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索" />
        </div>
        <button className="icon-button" type="button" title={refreshing ? "正在刷新" : "刷新"} onClick={onRefresh}>
          <RefreshCcw size={17} className={refreshing ? "spin" : ""} />
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
      <div className="session-count">{refreshing ? "刷新中..." : `${filtered.length} / ${sessions.length}`}</div>
      <div className="session-list">
        {filtered.map((session) => {
          const editing = editingId === session.id;
          return (
            <article
              className={`session-item ${selected === session.id ? "active" : ""} ${session.pinned ? "pinned" : ""} ${session.archived ? "archived" : ""}`}
              key={session.id}
            >
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
                  <div className="session-content">
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
                  <span className="session-resume-row">
                    <code className="session-resume-id" title={`codex resume ${session.resumeId || session.id}`}>
                      {session.resumeId || session.id}
                    </code>
                  </span>
                  </div>
                  <div className="session-actions">
                    <button
                      className={`pin-button ${session.pinned ? "pinned" : ""}`}
                      type="button"
                      title={session.pinned ? "取消置顶" : "置顶"}
                      aria-label={session.pinned ? "取消置顶" : "置顶"}
                      onClick={() => void togglePinned(session)}
                      disabled={pinningId === session.id}
                    >
                      <Pin size={15} fill={session.pinned ? "currentColor" : "none"} />
                    </button>
                    <button
                      className={`archive-button ${session.archived ? "archived" : ""}`}
                      type="button"
                      title={session.archived ? "取消归档" : "归档"}
                      aria-label={session.archived ? "取消归档" : "归档"}
                      onClick={() => void toggleArchived(session)}
                      disabled={archivingId === session.id}
                    >
                      {session.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
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
                  </div>
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
  models,
  onExport,
  onShowFile,
  onRunDone
}: {
  session: SessionDetail | null;
  selected: SessionSummary | null;
  loading: boolean;
  models: CodexModel[];
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

  const resumeId = selected?.resumeId || session?.resumeId || selected?.id || session?.id || "";

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
        setRunStatus(`已使用 ${formatShort(summary.usage?.total?.totalTokens || 0)} 令牌`);
      }
      return;
    }
    if (event.kind === "stderr") {
      const text = event.text.trim();
      if (text) {
        setLiveMessages((current) => appendLiveMessage(current, createLiveMessage("assistant", text, "日志")));
      }
      setRunStatus("Codex 正在运行");
      return;
    }
    if (event.kind === "error") {
      setLiveMessages((current) => appendLiveMessage(current, createLiveMessage("assistant", event.text, "error")));
      setRunStatus("运行失败");
      return;
    }
    if (event.kind === "done") {
      setRunStatus(
        event.signal
          ? `已停止（${event.signal}）`
          : event.code && event.code !== 0
            ? `退出码 ${event.code}`
            : "已完成，正在刷新会话"
      );
    }
  }, []);

  if (loading) return <main className="content-pane loading-pane">正在加载...</main>;
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
              <strong>{selected ? selected.title : "未选择会话"}</strong>
              {resumeId ? (
                <span className="detail-resume-row">
                  <code>{resumeId}</code>
                  <button
                    className="copy-id-button light"
                    type="button"
                    title="复制 resume id"
                    onClick={() => void copyText(resumeId)}
                  >
                    <Copy size={12} />
                  </button>
                </span>
              ) : null}
            </div>
          )}
        </section>
        <ThreadComposer
          selected={selected}
          models={models}
          onStart={handleRunStart}
          onEvent={handleRunEvent}
          onDone={onRunDone}
        />
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
            <div className="detail-resume-row" title={`codex resume ${resumeId}`}>
              <span>resume</span>
              <code>{resumeId}</code>
              <button
                className="copy-id-button light"
                type="button"
                title="复制 resume id"
                onClick={() => void copyText(resumeId)}
              >
                <Copy size={12} />
              </button>
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
          <Metric label="消息" value={messages.length} />
          <Metric label="令牌" value={session.tokenUsage?.total?.totalTokens || 0} />
          <Metric label="更新" value={formatDate(session.updatedAt)} />
        </section>

        {session.rateLimits ? (
          <section className="inline-usage">
            <RateBar label="短窗口" value={session.rateLimits.primary} />
            <RateBar label="长窗口" value={session.rateLimits.secondary} />
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
      <ThreadComposer
        selected={selected}
        models={models}
        onStart={handleRunStart}
        onEvent={handleRunEvent}
        onDone={onRunDone}
      />
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
          <p className="eyebrow">用量</p>
          <h1>限额与用量</h1>
          <div className="path-line">{usage?.codexHome || "~/.codex"}</div>
        </div>
        <button className="icon-button" type="button" title="刷新" onClick={onRefresh}>
          <RefreshCcw size={18} className={loading ? "spin" : ""} />
        </button>
      </section>

      <section className="session-stats">
        <Metric label="账户总量" value={usage?.summary.totalTokens || 0} />
        <Metric label="单日峰值" value={usage?.summary.maxTokens || 0} />
        <Metric label="本地会话" value={usage?.localSummary.sessions || 0} />
        <Metric label="本地总量" value={usage?.localSummary.totalTokens || 0} />
      </section>

      <section className="usage-source">
        <span className={isLive ? "status-dot live" : "status-dot"} />
        <span>
          {isLive
            ? `来自 ${usage?.account.codexBinary || "codex app-server"} 的实时账户数据`
            : `来自本地会话日志的估算${usage?.account.error ? `：${usage.account.error}` : ""}`}
        </span>
        <Metric label="更新" value={formatDate(usage?.summary.lastUpdated)} />
      </section>

      <section className="usage-block">
        <h2>限额窗口</h2>
        <RateBar label="短窗口" value={usage?.latest?.rateLimits?.primary || null} />
        <RateBar label="长窗口" value={usage?.latest?.rateLimits?.secondary || null} />
        <div className="micro muted">
          {usage?.latest?.observedAt ? `观测时间 ${formatFullDate(usage.latest.observedAt)}` : "-"}
        </div>
      </section>

      <section className="usage-block">
        <h2>{accountSummary ? "账户概览" : "最新令牌计数"}</h2>
        {accountSummary ? (
          <div className="token-grid">
            <Metric label="累计" value={accountSummary.lifetimeTokens || 0} />
            <Metric label="峰值日" value={accountSummary.peakDailyTokens || 0} />
            <Metric label="连续天数" value={accountSummary.currentStreakDays || 0} />
            <Metric label="最长连续" value={accountSummary.longestStreakDays || 0} />
            <Metric
              label="最长轮次"
              value={
                accountSummary.longestRunningTurnSec == null
                  ? "-"
                  : `${accountSummary.longestRunningTurnSec} 秒`
              }
            />
          </div>
        ) : (
          <TokenGrid usage={usage?.latest?.usage?.total || null} />
        )}
      </section>

      <section className="usage-block">
        <h2>每日用量</h2>
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
        <h2>工作目录</h2>
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
  const observedAt = usage?.latest?.observedAt || usage?.account.observedAt || usage?.summary.lastUpdated || null;
  const sourceLabel = usage?.account.available ? "Codex 实时限额" : "本地记录估算";
  const accountSummary = usage?.account.usage?.summary || null;
  const latestUsage = usage?.latest?.usage?.total || null;
  const daily = usage?.daily.slice(0, 7) || [];
  const workspaces = usage?.byWorkspace.slice(0, 5) || [];
  const maxDaily = Math.max(...daily.map((item) => item.tokens), 1);

  return (
    <aside className="usage-mini" aria-label="限额与用量">
      <div className="usage-mini-top">
        <div>
          <h2>限额与用量</h2>
          <span>{sourceLabel}</span>
        </div>
        <button className="icon-button" type="button" title="刷新" onClick={onRefresh}>
          <RefreshCcw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>

      <section className="usage-mini-metrics">
        <Metric label="总令牌" value={usage?.summary.totalTokens || 0} />
        <Metric label="本地会话" value={usage?.localSummary.sessions || 0} />
        <Metric label="当前窗口已用" value={`${usedPercent.toFixed(1)}%`} />
        <Metric label="剩余估算" value={`${remainingPercent.toFixed(1)}%`} />
      </section>

      <section className="usage-mini-block">
        <h3>限额窗口</h3>
        <RateBar label="短窗口" value={primary} />
        {secondary ? <RateBar label="长窗口" value={secondary} /> : null}
      </section>

      <section className="usage-mini-block">
        <h3>{accountSummary ? "账户概览" : "最新令牌"}</h3>
        {accountSummary ? (
          <div className="usage-mini-metrics">
            <Metric label="累计" value={accountSummary.lifetimeTokens || 0} />
            <Metric label="峰值日" value={accountSummary.peakDailyTokens || 0} />
            <Metric label="连续天数" value={accountSummary.currentStreakDays || 0} />
            <Metric label="最长连续" value={accountSummary.longestStreakDays || 0} />
          </div>
        ) : (
          <TokenGrid usage={latestUsage} />
        )}
      </section>

      <section className="usage-mini-block">
        <h3>每日用量</h3>
        <div className="bar-list">
          {daily.length ? daily.map((item) => (
            <div className="bar-row" key={item.date}>
              <span>{item.date.slice(5)}</span>
              <div className="bar-track">
                <div style={{ width: `${Math.max(2, (item.tokens / maxDaily) * 100)}%` }} />
              </div>
              <strong>{formatShort(item.tokens)}</strong>
            </div>
          )) : <div className="muted micro">暂无本地用量记录</div>}
        </div>
      </section>

      <section className="usage-mini-block">
        <h3>工作目录</h3>
        <div className="workspace-list">
          {workspaces.length ? workspaces.map((item) => (
            <div className="workspace-row" key={item.cwd}>
              <span title={item.cwd}>{basename(item.cwd || "未记录")}</span>
              <strong>{formatShort(item.tokens)}</strong>
            </div>
          )) : <div className="muted micro">暂无工作目录统计</div>}
        </div>
      </section>

      <div className="muted usage-mini-meta">
        <span className={usage?.account.available ? "status-dot live" : "status-dot"} />
        <span>最近刷新：{formatFullDate(observedAt)}</span>
      </div>
    </aside>
  );
}

function ThreadComposer({
  selected,
  models,
  onStart,
  onEvent,
  onDone
}: {
  selected: SessionSummary | null;
  models: CodexModel[];
  onStart: (prompt: string) => void;
  onEvent: (event: CodexRunEvent) => void;
  onDone: () => void;
}) {
  const [cwd, setCwd] = useState(selected?.cwd || "");
  const [model, setModel] = useState(readStoredModel);
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [statusText, setStatusText] = useState("就绪");
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (selected?.cwd) setCwd(selected.cwd);
  }, [selected?.cwd, selected?.id]);

  useEffect(() => {
    const options = models.length ? models : FALLBACK_MODEL_OPTIONS;
    const ids = new Set(options.map((option) => option.id));
    const nextModel = ids.has(model)
      ? model
      : ids.has(DEFAULT_DESK_MODEL)
        ? DEFAULT_DESK_MODEL
        : options[0]?.id || DEFAULT_DESK_MODEL;
    if (nextModel !== model) {
      setModel(nextModel);
      window.localStorage.setItem(MODEL_KEY, nextModel);
    }
  }, [model, models]);

  useEffect(() => {
    return window.codexDesk.onCodexEvent((event) => {
      if (!runIdRef.current || event.runId !== runIdRef.current) return;
      onEvent(event);
      if (event.kind === "done" || event.kind === "error") {
        runIdRef.current = null;
        setRunId(null);
        setStarting(false);
        setStatusText(
          event.kind === "error"
            ? "失败"
            : event.signal
              ? "已停止"
              : event.code && event.code !== 0
                ? `已退出 ${event.code}`
                : "已完成"
        );
        onDone();
      }
    });
  }, [onDone, onEvent]);

  const start = async () => {
    const text = prompt.trim();
    if (!text || runId || starting) return;
    const targetSessionId = selected?.resumeId || selected?.id || undefined;
    setStarting(true);
    setStatusText(targetSessionId ? "正在继续当前会话" : "正在创建新会话");
    onStart(text);
    try {
      const result = await window.codexDesk.runCodex({
        prompt: text,
        cwd: cwd || selected?.cwd || undefined,
        model: model || DEFAULT_DESK_MODEL,
        sessionId: targetSessionId
      });
      setPrompt("");
      runIdRef.current = result.runId;
      setRunId(result.runId);
      setStatusText("运行中");
    } catch (error) {
      setStarting(false);
      setStatusText("失败");
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
    runIdRef.current = null;
    setRunId(null);
    setStarting(false);
    setStatusText("已停止");
  };
  const composerCwd = cwd || selected?.cwd || "";
  const canSend = Boolean(prompt.trim()) && !runId && !starting;
  const currentPlace = selected ? "当前会话" : "新会话";
  const modelOptions = models.length ? models : FALLBACK_MODEL_OPTIONS;
  const selectedModelKnown = modelOptions.some((option) => option.id === model);

  return (
    <section className="thread-composer" aria-label="Codex 输入区">
      <div className="composer-shell">
        <textarea
          className="prompt-box"
          lang="zh-CN"
          spellCheck={false}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionUpdate={(event) => {
            setPrompt(event.currentTarget.value);
          }}
          onCompositionEnd={(event) => {
            setIsComposing(false);
            setPrompt(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isComposing || event.nativeEvent.isComposing || event.key === "Process") return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
          placeholder={selected ? "继续当前会话" : "新建会话"}
        />

        <div className="composer-toolbar">
          <div className="composer-context">
            <span className="target-pill" title={selected ? `codex resume ${selected.resumeId || selected.id}` : "新会话"}>
              {currentPlace}
            </span>
            <select
              className="composer-select"
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                window.localStorage.setItem(MODEL_KEY, event.target.value);
              }}
              title="模型"
            >
              {!selectedModelKnown ? <option value={model}>{formatModelName(model)}</option> : null}
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            <label className="composer-cwd" title={composerCwd || "工作目录"}>
              <span>目录</span>
              <input
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={selected?.cwd || "工作目录"}
                title="工作目录"
              />
            </label>
            <button
              className="icon-button ghost"
              type="button"
              title="打开工作目录"
              onClick={() => composerCwd && window.codexDesk.openPath(composerCwd)}
              disabled={!composerCwd}
            >
              <FolderOpen size={16} />
            </button>
          </div>

          <div className="composer-actions">
            <span className="composer-status">{statusText}</span>
            <button className="send-button run" type="button" title="发送" onClick={start} disabled={!canSend}>
              <Play size={18} />
              发送
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
    return <div className="run-line event">完成 代码={event.code ?? "-"} 信号={event.signal ?? "-"}</div>;
  }

  const summary = event.summary;
  if (summary.kind === "message") {
    return (
      <article className={`run-message ${summary.role}`}>
        <header>{summary.role === "user" ? "用户" : "Codex"}</header>
        <MarkdownBlock text={summary.text} />
      </article>
    );
  }
  if (summary.kind === "usage") {
    return <div className="run-line usage">令牌 {formatShort(summary.usage?.total?.totalTokens || 0)}</div>;
  }
  return <pre className={`run-line ${summary.kind}`}>{summary.text}</pre>;
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [models, setModels] = useState<CodexModel[]>(FALLBACK_MODEL_OPTIONS);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionReloadKey, setSessionReloadKey] = useState(0);
  const [railWidth, setRailWidth] = useState(readStoredRailWidth);
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  const sessionRefreshRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    if (sessionRefreshRef.current) return sessionRefreshRef.current;
    setLoadingSessions(true);
    const refresh = window.codexDesk
      .listSessions()
      .then((next) => {
        const ordered = sortSessions(next);
        const selectable = showArchived ? ordered : ordered.filter((session) => !session.archived);
        setSessions(ordered);
        setSelected((current) => {
          if (!current) return selectable[0] || null;
          const matched = ordered.find((session) =>
            session.id === current.id ||
            session.resumeId === current.resumeId ||
            session.filePath === current.filePath
          );
          if (matched && (showArchived || !matched.archived)) return matched;
          return selectable[0] || null;
        });
      })
      .catch((error) => {
        setToast(`刷新 session 失败：${error instanceof Error ? error.message : String(error)}`);
        window.setTimeout(() => setToast(null), 3600);
      })
      .finally(() => {
        setLoadingSessions(false);
        sessionRefreshRef.current = null;
      });
    sessionRefreshRef.current = refresh;
    return refresh;
  }, [showArchived]);

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
    window.codexDesk.listModels().then((next) => {
      if (next.length) setModels(next);
    }).catch(() => {});
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

  const togglePinnedSession = useCallback(async (session: SessionSummary, pinned: boolean) => {
    const result = await window.codexDesk.pinSession(session.id, session.filePath, pinned);
    const matches = (item: Pick<SessionSummary, "id" | "resumeId" | "filePath">) =>
      item.id === session.id || item.resumeId === session.resumeId || item.filePath === session.filePath;
    const updateSummary = (item: SessionSummary): SessionSummary =>
      matches(item) ? { ...item, pinned: result.pinned } : item;
    const updateDetail = (item: SessionDetail): SessionDetail =>
      matches(item) ? { ...item, pinned: result.pinned } : item;
    setSessions((current) => sortSessions(current.map(updateSummary)));
    setSelected((current) => (current ? updateSummary(current) : current));
    setDetail((current) => (current ? updateDetail(current) : current));
  }, []);

  const toggleArchiveSession = useCallback(async (session: SessionSummary, archived: boolean) => {
    const result = await window.codexDesk.archiveSession(session.id, session.filePath, archived);
    const matches = (item: Pick<SessionSummary, "id" | "resumeId" | "filePath">) =>
      item.id === session.id || item.resumeId === session.resumeId || item.filePath === session.filePath;
    const updateSummary = (item: SessionSummary): SessionSummary =>
      matches(item) ? { ...item, archived: result.archived } : item;
    const updateDetail = (item: SessionDetail): SessionDetail =>
      matches(item) ? { ...item, archived: result.archived } : item;
    const nextSessions = sortSessions(sessions.map(updateSummary));
    setSessions(nextSessions);
    if (result.archived && !showArchived) {
      const replacement = nextSessions.find((item) => !item.archived) || null;
      setSelected((current) => (current && matches(current) ? replacement : current));
      setDetail((current) => (current && matches(current) ? null : current));
    } else {
      setSelected((current) => (current ? updateSummary(current) : current));
      setDetail((current) => (current ? updateDetail(current) : current));
    }
    setToast(result.archived ? `已归档 ${session.title}` : `已取消归档 ${session.title}`);
    window.setTimeout(() => setToast(null), 2400);
  }, [sessions, showArchived]);

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

  const startNewSession = useCallback(() => {
    setSelected(null);
    setDetail(null);
    setSessionReloadKey((value) => value + 1);
  }, []);

  return (
    <div className="app-shell" data-theme={theme}>
      <nav className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <img src={codexDeskIcon} alt="" />
          </span>
          <div>
            <strong>Codex Desk</strong>
            <small>本地桌面</small>
          </div>
        </div>
        <div className="tabs">
          <MessageSquare size={16} />
          会话
        </div>
        <div className="topbar-actions">
          <button className="link-button primary-action" type="button" onClick={startNewSession}>
            <Plus size={16} />
            新会话
          </button>
          <button
            className="link-button"
            type="button"
            onClick={() => selected && window.codexDesk.openPath(selected.cwd)}
            disabled={!selected?.cwd}
          >
            <ExternalLink size={16} />
            工作目录
          </button>
          <button
            className="icon-button theme-toggle"
            type="button"
            title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
            aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
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
          refreshing={loadingSessions}
          onRename={renameSession}
          onTogglePinned={togglePinnedSession}
          onToggleSessionArchived={toggleArchiveSession}
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
          models={models}
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
