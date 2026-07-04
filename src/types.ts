export type Role = "user" | "assistant";

export type TokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: unknown | null;
  individualLimit: unknown | null;
  rateLimitReachedType: string | null;
};

export type SessionSummary = {
  id: string;
  resumeId: string;
  filePath: string;
  title: string;
  preview: string;
  cwd: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;
  archived: boolean;
  pinned: boolean;
  source: string;
};

export type SessionMessage = {
  kind: "message";
  id: string;
  role: Role;
  phase: string | null;
  timestamp: string | null;
  text: string;
};

export type SessionEvent = {
  kind: "tool_call" | "tool_output";
  id: string;
  timestamp: string | null;
  name: string;
  text: string;
};

export type SessionDetail = {
  id: string;
  resumeId: string;
  filePath: string;
  title: string;
  preview: string;
  cwd: string;
  model: string;
  cliVersion: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  messages: SessionMessage[];
  events: SessionEvent[];
  tokenUsage: {
    total: TokenBreakdown | null;
    last: TokenBreakdown | null;
    modelContextWindow: number | null;
  } | null;
  rateLimits: RateLimitSnapshot | null;
};

export type UsageSnapshot = {
  codexHome: string;
  summary: {
    sessions: number;
    totalTokens: number;
    maxTokens: number;
    lastUpdated: number;
  };
  localSummary: {
    sessions: number;
    totalTokens: number;
    maxTokens: number;
    lastUpdated: number;
  };
  daily: Array<{ date: string; sessions: number; tokens: number }>;
  byWorkspace: Array<{ cwd: string; sessions: number; tokens: number }>;
  latest: {
    observedAt: number;
    usage: {
      total: TokenBreakdown | null;
      last: TokenBreakdown | null;
      modelContextWindow: number | null;
    } | null;
    rateLimits: RateLimitSnapshot | null;
    filePath: string;
  } | null;
  account: {
    available: boolean;
    observedAt: number;
    codexBinary: string;
    error: string | null;
    usage: {
      summary: {
        lifetimeTokens: number | null;
        peakDailyTokens: number | null;
        longestRunningTurnSec: number | null;
        currentStreakDays: number | null;
        longestStreakDays: number | null;
      };
      dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
    } | null;
    rateLimits: {
      rateLimits: RateLimitSnapshot | null;
      rateLimitsByLimitId: Record<string, RateLimitSnapshot | null> | null;
      rateLimitResetCredits: unknown | null;
    } | null;
  };
};

export type LatestUsage = NonNullable<UsageSnapshot["latest"]>["usage"];

export type CodexModel = {
  id: string;
  name: string;
};

export type RunSummary =
  | { kind: "message"; role: Role; phase: string | null; text: string }
  | { kind: "tool"; text: string }
  | { kind: "tool_output"; text: string }
  | { kind: "usage"; usage: LatestUsage; rateLimits: RateLimitSnapshot | null }
  | { kind: "event"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "stdout"; text: string };

export type CodexRunEvent =
  | { runId: string; kind: "started"; args: string[] }
  | { runId: string; kind: "record"; raw: string; record: unknown; summary: RunSummary }
  | { runId: string; kind: "stderr"; text: string }
  | { runId: string; kind: "error"; text: string }
  | { runId: string; kind: "done"; code: number | null; signal: string | null };

export type CodexDeskApi = {
  listSessions: () => Promise<SessionSummary[]>;
  readSession: (filePath: string) => Promise<SessionDetail>;
  renameSession: (id: string, title: string) => Promise<{ id: string; title: string }>;
  pinSession: (id: string, filePath: string, pinned: boolean) => Promise<{ id: string; pinned: boolean }>;
  archiveSession: (id: string, filePath: string, archived: boolean) => Promise<{ id: string; archived: boolean }>;
  deleteSession: (id: string, filePath: string) => Promise<{ id: string; deletedPath: string }>;
  exportSession: (filePath: string) => Promise<{ canceled: boolean; filePath?: string }>;
  listModels: () => Promise<CodexModel[]>;
  getUsage: () => Promise<UsageSnapshot>;
  runCodex: (options: {
    prompt: string;
    cwd?: string;
    model?: string;
    sessionId?: string;
  }) => Promise<{ runId: string }>;
  cancelRun: (runId: string) => Promise<boolean>;
  openPath: (targetPath: string) => Promise<string>;
  showItem: (targetPath: string) => Promise<boolean>;
  onCodexEvent: (callback: (payload: CodexRunEvent) => void) => () => void;
};
