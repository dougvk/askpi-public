import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  computeCompletionId,
  applyDeliveryResolvers,
  inferDiscordToFromSessionKey as inferDiscordToFromSessionKeyLib,
  inferDeliveryHintFromSessionKey,
  normalizeDeliveryHint as normalizeDeliveryHintLib,
  normalizeDeliveryHintForSessionKey,
  resolveSessionStorePath,
  shellQuote,
} from "./lib.js";

const execFileAsync = promisify(execFile);

const DEFAULT_ASKCODEX_CODEX_HOME = path.resolve(homedir(), ".cache", "askcodex-codex-home");
const ASKPI_TMUX_SOCKET_NAME_ENV_KEY = "OPENCLAW_ASKPI_TMUX_SOCKET_NAME";
const ASKPI_TMUX_SOCKET_PATH_ENV_KEY = "OPENCLAW_ASKPI_TMUX_SOCKET_PATH";
const OPENCLAW_TMUX_SOCKET_DIR_ENV_KEY = "OPENCLAW_TMUX_SOCKET_DIR";
const CLAWDBOT_TMUX_SOCKET_DIR_ENV_KEY = "CLAWDBOT_TMUX_SOCKET_DIR";
const DEFAULT_ASKPI_TMUX_SOCKET_NAME = "openclaw-askpi";
const DEFAULT_ASKPI_TMUX_SOCKET_FILE = `${DEFAULT_ASKPI_TMUX_SOCKET_NAME}.sock`;

type PluginConfig = {
  token?: string;
  tmuxPrefix?: string;
  httpPath?: string;
  deliveryResolvers?: DeliveryResolverConfig[];
};

type DeliveryResolverConfig = {
  channel: string;
  pattern: string;
  toTemplate: string;
  threadIdTemplate?: string;
  messageThreadIdTemplate?: string;
  accountIdTemplate?: string;
  compiled?: RegExp;
};

type AskpiTmuxSocketConfig = {
  tmuxArgs: string[];
  socketPath?: string;
  displayArgs: string;
};

export function resolveAskpiTmuxSocketConfig(
  env: NodeJS.ProcessEnv = process.env,
): AskpiTmuxSocketConfig {
  const explicitSocketPath = env[ASKPI_TMUX_SOCKET_PATH_ENV_KEY]?.trim();
  if (explicitSocketPath) {
    return {
      tmuxArgs: ["-S", explicitSocketPath],
      socketPath: explicitSocketPath,
      displayArgs: `-S ${shellQuote(explicitSocketPath)}`,
    };
  }

  const explicitSocketName = env[ASKPI_TMUX_SOCKET_NAME_ENV_KEY]?.trim();
  if (explicitSocketName) {
    return {
      tmuxArgs: ["-L", explicitSocketName],
      displayArgs: `-L ${shellQuote(explicitSocketName)}`,
    };
  }

  const socketDir =
    env[OPENCLAW_TMUX_SOCKET_DIR_ENV_KEY]?.trim() ||
    env[CLAWDBOT_TMUX_SOCKET_DIR_ENV_KEY]?.trim() ||
    path.join(env.TMPDIR || "/tmp", "openclaw-tmux-sockets");
  const socketPath = path.join(socketDir, DEFAULT_ASKPI_TMUX_SOCKET_FILE);
  return {
    tmuxArgs: ["-S", socketPath],
    socketPath,
    displayArgs: `-S ${shellQuote(socketPath)}`,
  };
}

async function ensureAskpiTmuxSocketDir(config: AskpiTmuxSocketConfig): Promise<void> {
  if (!config.socketPath) {
    return;
  }
  try {
    await fs.mkdir(path.dirname(config.socketPath), { recursive: true });
  } catch {
    // Best-effort only. tmux call will return an actionable error if this fails.
  }
}

export function buildAskpiTmuxAttachCommand(
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const socketConfig = resolveAskpiTmuxSocketConfig(env);
  return `tmux ${socketConfig.displayArgs} attach -t ${sessionName}`;
}

// Clawdbot (origin/main) requires every plugin to export a configSchema.
// Keep this lightweight and dependency-free (no zod/typebox), and validate
// only what we need for safe operation. Schema/UI hints live in the manifest.
const PluginConfigSchema = {
  allowedKeys: ["token", "tmuxPrefix", "httpPath", "deliveryResolvers"] as const,
  requiredKeys: ["token"] as const,
  validate(value: unknown): { ok: true; value?: unknown } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, errors: ["<root>: expected object"] };
    }
    const obj = value as Record<string, unknown>;

    const token = typeof obj.token === "string" ? obj.token.trim() : "";
    if (!token) errors.push("token: required");

    if ("tmuxPrefix" in obj && obj.tmuxPrefix != null && typeof obj.tmuxPrefix !== "string") {
      errors.push("tmuxPrefix: expected string");
    }
    if ("httpPath" in obj && obj.httpPath != null && typeof obj.httpPath !== "string") {
      errors.push("httpPath: expected string");
    }
    if ("deliveryResolvers" in obj && obj.deliveryResolvers != null) {
      if (!Array.isArray(obj.deliveryResolvers)) {
        errors.push("deliveryResolvers: expected array");
      } else {
        obj.deliveryResolvers.forEach((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            errors.push(`deliveryResolvers[${index}]: expected object`);
            return;
          }
          const resolver = entry as Record<string, unknown>;
          const channel = typeof resolver.channel === "string" ? resolver.channel.trim() : "";
          const pattern = typeof resolver.pattern === "string" ? resolver.pattern.trim() : "";
          const toTemplate =
            typeof resolver.toTemplate === "string" ? resolver.toTemplate.trim() : "";
          if (!channel) errors.push(`deliveryResolvers[${index}].channel: required`);
          if (!pattern) errors.push(`deliveryResolvers[${index}].pattern: required`);
          if (!toTemplate) errors.push(`deliveryResolvers[${index}].toTemplate: required`);
          if (pattern) {
            try {
              new RegExp(pattern);
            } catch {
              errors.push(`deliveryResolvers[${index}].pattern: invalid regex`);
            }
          }
          const optionalStringKeys = [
            "threadIdTemplate",
            "messageThreadIdTemplate",
            "accountIdTemplate",
          ];
          for (const key of optionalStringKeys) {
            if (key in resolver && resolver[key] != null && typeof resolver[key] !== "string") {
              errors.push(`deliveryResolvers[${index}].${key}: expected string`);
            }
          }
        });
      }
    }

    // Catch typos early.
    const allowed = new Set(PluginConfigSchema.allowedKeys);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        errors.push(`${key}: unknown key`);
      }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: obj };
  },
} as const;

type CodingSessionRecordV1 = {
  version: 1;
  sessionKey: string;
  agentId: string;
  codingSessionId: string;
  /** Best-effort delivery hint so callbacks can reply to the originating chat even if the session store entry is missing. */
  delivery?: {
    channel?: string;
    to?: string;
    accountId?: string;
    /** Generic thread identifier used by outbound adapters (e.g. Telegram forum topic id). */
    threadId?: string | number;
    /** Telegram-specific forum topic/thread id (duplicated for clarity / future migrations). */
    messageThreadId?: string | number;
    /** Telegram forum marker (best-effort). */
    isForum?: boolean;
  };
  tmux: {
    name: string;
    /** Last time we verified the tmux session existed (ms since epoch). */
    lastSeenAt?: number;
    /** If set, the tmux session was missing as of this time (ms since epoch). */
    missingSince?: number;
  };
  cwd: string;
  pi: {
    sessionDir: string;
    sessionFile?: string;
    sessionId?: string;
    extensionPath: string;
    /** Base Pi command args (no secrets). */
    piArgs: string[];
  };
  inFlight?: {
    mode: "prompt" | "follow_up";
    reqId?: string;
    sentAt: number;
    messagePreview: string;
  };
  lastCompletion?: {
    eventId: string;
    endedAt: number;
  };
  /** Last notify received (idempotency + diagnostics). */
  lastNotify?: {
    completionId: string;
    eventId?: string;
    receivedAt: number;
  };
  /** Completion id we most recently delivered successfully (exactly-once). */
  lastDeliveredCompletionId?: string;
  /** Last successful delivery metadata (best-effort). */
  lastDeliveryResult?: {
    channel: string;
    messageId?: string;
    channelId?: string;
    chatId?: string;
    threadId?: string | number | null;
    deliveredAt: number;
  };
  /** Last attempted delivery error (if any). */
  lastDeliveryError?: string;
  /** Timestamp (ms) of last delivery attempt. */
  lastDeliveryAttemptAt?: number;
  updatedAt: number;
  createdAt: number;
  lastError?: string;
};

type CodingSessionsToolAction =
  | "help"
  | "new"
  | "send"
  | "reset"
  | "stop"
  | "status"
  | "handoff"
  | "resume";

// Plain JSON schema (avoids requiring TypeBox installed next to this plugin).
const CodingSessionsToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      description: "Action: help|new|send|reset|stop|status|handoff|resume",
    },
    cwd: {
      type: "string",
      description: "Absolute path to the project directory (optional for action=new).",
    },
    message: { type: "string", description: "Message to send to Pi." },

    // Tool-dispatch payload (from Clawdbot skill commands):
    // { command: "<raw args>", commandName: "askpi", skillName: "askpi" }
    command: { type: "string", description: "Raw /askpi args (skill command dispatch)." },
    commandName: { type: "string", description: "Slash command name (skill command dispatch)." },
    skillName: { type: "string", description: "Skill name (skill command dispatch)." },
    // Deprecated: we do not support interrupt/steer. Mode is accepted for backward compatibility
    // but ignored. The tool will either start a prompt immediately (idle) or queue a follow-up (busy).
    mode: { type: "string", description: "(deprecated) Ignored. The tool queues follow-ups when Pi is busy." },
  },
  required: ["action"],
};

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text", text }],
    ...(details !== undefined ? { details } : {}),
  };
}

function readString(params: Record<string, unknown>, key: string, opts?: { required?: boolean }) {
  const raw = params[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value && opts?.required) {
    throw new Error(`${key} required`);
  }
  return value || undefined;
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const raw = params[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseFloat(raw.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (!v) return undefined;
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return undefined;
}

function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function safePreview(text: string, max = 160): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function normalizeHttpPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/askpi/notify";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeDeliveryResolvers(
  raw: unknown,
  logger?: { warn?: (message: string) => void },
): DeliveryResolverConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: DeliveryResolverConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const resolver = entry as Record<string, unknown>;
    const channel = typeof resolver.channel === "string" ? resolver.channel.trim() : "";
    const pattern = typeof resolver.pattern === "string" ? resolver.pattern.trim() : "";
    const toTemplate = typeof resolver.toTemplate === "string" ? resolver.toTemplate.trim() : "";
    if (!channel || !pattern || !toTemplate) continue;
    let compiled: RegExp | null = null;
    try {
      compiled = new RegExp(pattern);
    } catch {
      logger?.warn?.(`[askpi] deliveryResolvers: invalid regex pattern "${pattern}"`);
      continue;
    }
    out.push({
      channel,
      pattern,
      toTemplate,
      compiled,
      ...(typeof resolver.threadIdTemplate === "string"
        ? { threadIdTemplate: resolver.threadIdTemplate }
        : {}),
      ...(typeof resolver.messageThreadIdTemplate === "string"
        ? { messageThreadIdTemplate: resolver.messageThreadIdTemplate }
        : {}),
      ...(typeof resolver.accountIdTemplate === "string"
        ? { accountIdTemplate: resolver.accountIdTemplate }
        : {}),
    });
  }
  return out;
}

function resolvePluginConfig(api: any): Required<PluginConfig> {
  const raw = (api?.pluginConfig ?? {}) as PluginConfig;
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  const tmuxPrefix = typeof raw.tmuxPrefix === "string" && raw.tmuxPrefix.trim()
    ? raw.tmuxPrefix.trim()
    : "clawd-pi";
  const httpPath = typeof raw.httpPath === "string" && raw.httpPath.trim()
    ? raw.httpPath.trim()
    : "/askpi/notify";
  const deliveryResolvers = normalizeDeliveryResolvers(raw.deliveryResolvers, api?.logger);
  return { token, tmuxPrefix, httpPath, deliveryResolvers };
}

let pluginApi: any = null;
let pluginRootDir: string | null = null;

function inferAgentIdFromSessionKey(sessionKey: string): string | null {
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m?.[1] ?? null;
}

function loadGatewayConfig(): any {
  try {
    return pluginApi?.runtime?.config?.loadConfig?.() ?? pluginApi?.config ?? {};
  } catch {
    return pluginApi?.config ?? {};
  }
}

function normalizeHomePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function resolveAskpiPiAgentDir(): string {
  const cfg = loadGatewayConfig();
  const askcodexHomeRaw =
    typeof cfg?.plugins?.entries?.askcodex?.config?.codexHome === "string"
      ? cfg.plugins.entries.askcodex.config.codexHome
      : "";
  const normalized = normalizeHomePath(askcodexHomeRaw);
  if (normalized) return normalized;
  return DEFAULT_ASKCODEX_CODEX_HOME;
}

function resolvePluginRootDir(): string | null {
  if (pluginRootDir) return pluginRootDir;
  const source = typeof pluginApi?.source === "string" ? pluginApi.source.trim() : "";
  if (!source) return null;
  pluginRootDir = path.dirname(source);
  return pluginRootDir;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function withRecordLock<T>(recordPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${recordPath}.lock`;
  const timeoutMs = 15_000;
  const staleMs = 5 * 60_000;
  const start = Date.now();

  // Ensure parent dir exists so lock creation works.
  await fs.mkdir(path.dirname(recordPath), { recursive: true });

  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx");
      try {
        await fh.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now(), recordPath }, null, 2) + "\n",
          "utf8",
        );
      } catch {
        // ignore
      }
      try {
        return await fn();
      } finally {
        await fh.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch (err) {
      // If lock exists, check staleness.
      const message = err instanceof Error ? err.message : String(err);
      if (!/EEXIST/i.test(message)) {
        throw err;
      }
      const st = await fs.stat(lockPath).catch(() => null);
      const age = st ? Date.now() - st.mtimeMs : 0;
      if (st && age > staleMs) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`askpi: timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function normalizeDeliveryHint(value: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  messageThreadId?: string | number;
  isForum?: boolean;
} | null | undefined): {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  messageThreadId?: string | number;
  isForum?: boolean;
} | null {
  return normalizeDeliveryHintLib(value);
}

function inferDiscordToFromSessionKey(sessionKey: string): string | null {
  return inferDiscordToFromSessionKeyLib(sessionKey);
}

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;

function stripInlineDirectivesForUserFacingText(text: string): string {
  return text
    .replace(REPLY_TAG_RE, " ")
    .replace(AUDIO_TAG_RE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

async function findMostRecentJsonlFile(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
    if (files.length === 0) return null;

    const stats = await Promise.all(
      files.map(async (name) => {
        const full = path.join(dir, name);
        const st = await fs.stat(full).catch(() => null);
        return st ? { full, mtimeMs: st.mtimeMs } : null;
      }),
    );

    const sorted = stats
      .filter(Boolean)
      .sort((a: any, b: any) => (b?.mtimeMs ?? 0) - (a?.mtimeMs ?? 0)) as Array<{
      full: string;
      mtimeMs: number;
    }>;
    return sorted[0]?.full ?? null;
  } catch {
    return null;
  }
}

async function readLastJsonlEntries(filePath: string, maxBytes = 2 * 1024 * 1024): Promise<any[]> {
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      // If we didn't read from byte 0, the first line might be partial JSON; drop it.
      if (start > 0) lines.shift();
      const out: any[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed));
        } catch {
          // ignore
        }
      }
      return out;
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch {
    return [];
  }
}

function extractTextFromPiMessageContent(content: any): string {
  // Pi AgentMessage content is an array of items like {type:"text", text:"..."}.
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      out += item.text;
    }
  }
  return out;
}

async function resolvePiFinalAssistantText(params: {
  piSessionFile?: string;
  piSessionDir?: string;
}): Promise<string | null> {
  const filePath =
    (params.piSessionFile && existsSync(params.piSessionFile) ? params.piSessionFile : null) ??
    (params.piSessionDir ? await findMostRecentJsonlFile(params.piSessionDir) : null);
  if (!filePath) return null;

  const entries = await readLastJsonlEntries(filePath);
  let fallback: string | null = null;
  let preferred: string | null = null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;
    if (e.type !== "message") continue;
    const msg = e.message;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant") continue;

    const textRaw = extractTextFromPiMessageContent(msg.content);
    const text = typeof textRaw === "string" ? stripInlineDirectivesForUserFacingText(textRaw) : "";
    if (!text) continue;

    const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
    if (/^(stop|end_turn)$/i.test(stopReason)) {
      preferred = text;
      break;
    }
    if (!fallback) fallback = text;
  }

  return preferred ?? fallback;
}

function truncateForPeek(text: string, maxChars = 800): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateForPromptLog(text: string, maxChars = 1800): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}… (truncated; ${trimmed.length} chars total)`;
}

async function deliverBestEffortOutboundText(params: {
  delivery: { channel: string; to: string; accountId?: string; threadId?: string | number | null };
  text: string;
}): Promise<{
  channel: string;
  messageId?: string;
  channelId?: string;
  chatId?: string;
  threadId?: string | number | null;
}> {
  const runtime = pluginApi?.runtime;
  if (!runtime) {
    throw new Error("askpi: plugin runtime not available (not registered?)");
  }

  const channel = params.delivery.channel;
  const to = params.delivery.to;

  const parseOptionalInt = (raw: unknown): number | undefined => {
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === "string") {
      const t = raw.trim();
      if (!t) return undefined;
      if (!/^\d+$/.test(t)) return undefined;
      const n = Number.parseInt(t, 10);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };

  if (channel === "discord") {
    const res = await runtime.channel.discord.sendMessageDiscord(to, params.text, {
      accountId: params.delivery.accountId,
    });
    return {
      channel,
      messageId: typeof res?.messageId === "string" ? res.messageId : undefined,
      channelId: typeof res?.channelId === "string" ? res.channelId : undefined,
    };
  }

  if (channel === "telegram") {
    const messageThreadId = parseOptionalInt(params.delivery.threadId ?? undefined);
    const res = await runtime.channel.telegram.sendMessageTelegram(to, params.text, {
      accountId: params.delivery.accountId,
      ...(typeof messageThreadId === "number" ? { messageThreadId } : {}),
    });
    return {
      channel,
      messageId: typeof res?.messageId === "string" ? res.messageId : undefined,
      chatId: typeof res?.chatId === "string" ? res.chatId : undefined,
      threadId: messageThreadId ?? null,
    };
  }

  if (channel === "slack") {
    const threadTs = typeof params.delivery.threadId === "string" ? params.delivery.threadId.trim() : "";
    const res = await runtime.channel.slack.sendMessageSlack(to, params.text, {
      accountId: params.delivery.accountId,
      ...(threadTs ? { threadTs } : {}),
    });
    return {
      channel,
      messageId: typeof res?.messageId === "string" ? res.messageId : undefined,
      channelId: typeof res?.channelId === "string" ? res.channelId : undefined,
      threadId: threadTs || null,
    };
  }

  throw new Error(`askpi: unsupported delivery channel: ${channel}`);
}

async function resolvePiPeekActivity(params: {
  piSessionFile?: string;
  piSessionDir?: string;
}): Promise<
  | {
      sessionFile: string;
      lastEventType?: string;
      lastToolName?: string;
      lastAssistantText?: string;
    }
  | null
> {
  const filePath =
    (params.piSessionFile && existsSync(params.piSessionFile) ? params.piSessionFile : null) ??
    (params.piSessionDir ? await findMostRecentJsonlFile(params.piSessionDir) : null);
  if (!filePath) return null;

  const entries = await readLastJsonlEntries(filePath, 512 * 1024);
  let lastEventType: string | undefined;
  let lastToolName: string | undefined;
  let lastAssistantText: string | undefined;

  const tryExtractAssistant = (msg: any): string | null => {
    if (!msg || typeof msg !== "object") return null;
    if (msg.role !== "assistant") return null;
    const raw = extractTextFromPiMessageContent(msg.content);
    const cleaned = stripInlineDirectivesForUserFacingText(raw);
    return cleaned ? cleaned : null;
  };

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;
    if (!lastEventType && typeof e.type === "string") lastEventType = e.type;
    if (!lastToolName && e.type === "tool_execution_end" && typeof e.toolName === "string") {
      lastToolName = e.toolName;
    }

    if (!lastAssistantText) {
      if (e.type === "agent_end" && Array.isArray(e.messages)) {
        for (let j = e.messages.length - 1; j >= 0; j--) {
          const txt = tryExtractAssistant(e.messages[j]);
          if (txt) {
            lastAssistantText = truncateForPeek(txt);
            break;
          }
        }
      }
      if (!lastAssistantText && e.type === "message") {
        const txt = tryExtractAssistant(e.message);
        if (txt) lastAssistantText = truncateForPeek(txt);
      }
    }

    if (lastAssistantText && lastToolName && lastEventType) break;
  }

  return {
    sessionFile: filePath,
    lastEventType,
    lastToolName,
    lastAssistantText,
  };
}

async function readSessionDeliveryHint(params: {
  agentRootDir: string;
  sessionKey: string;
  deliveryResolvers?: DeliveryResolverConfig[];
}): Promise<
  | {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
      messageThreadId?: string | number;
      isForum?: boolean;
    }
  | null
> { 
  const cfg = loadGatewayConfig();
  const storeOverride = typeof cfg?.session?.store === "string" ? cfg.session.store : undefined;
  const storePath = resolveSessionStorePath({
    agentRootDir: params.agentRootDir,
    agentId: inferAgentIdFromSessionKey(params.sessionKey) ?? undefined,
    storeOverride,
  });
  const resolverHint = applyDeliveryResolvers(params.sessionKey, params.deliveryResolvers);
  const fallback =
    resolverHint ?? inferDeliveryHintFromSessionKey(params.sessionKey);
  const store = await readJsonFile<Record<string, any>>(storePath);
  if (!store) {
    // Best-effort fallback when the session store entry is missing (e.g. after pruning).
    return fallback;
  }
  const entry = store[params.sessionKey];
  if (!entry || typeof entry !== "object") {
    return fallback;
  }

  // Prefer normalized deliveryContext when present.
  const deliveryContext = entry.deliveryContext;
  if (deliveryContext && typeof deliveryContext === "object") {
    const ctx = normalizeDeliveryHintForSessionKey(
      {
        channel:
          typeof deliveryContext.channel === "string" ? deliveryContext.channel : undefined,
        to: typeof deliveryContext.to === "string" ? deliveryContext.to : undefined,
        accountId:
          typeof deliveryContext.accountId === "string"
            ? deliveryContext.accountId
            : undefined,
      },
      params.sessionKey,
    );
    if (ctx) return ctx;
  }

  const channel = typeof entry.lastChannel === "string" ? entry.lastChannel : undefined;
  const to = typeof entry.lastTo === "string" ? entry.lastTo : undefined;
  const accountId = typeof entry.lastAccountId === "string" ? entry.lastAccountId : undefined;
  return (
    normalizeDeliveryHintForSessionKey({ channel, to, accountId }, params.sessionKey) ??
    fallback
  );
}

async function tmux(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const socketConfig = resolveAskpiTmuxSocketConfig();
  await ensureAskpiTmuxSocketDir(socketConfig);
  const tmuxArgs = [...socketConfig.tmuxArgs, ...args];
  try {
    const res = await execFileAsync("tmux", tmuxArgs, { encoding: "utf8" });
    return { stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? ""), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function tmuxHasSession(name: string): Promise<boolean> {
  const res = await tmux(["has-session", "-t", name]);
  return res.code === 0;
}

async function tmuxListSessionNames(): Promise<Set<string>> {
  const res = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (res.code !== 0) return new Set();
  const names = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return new Set(names);
}

async function tmuxKillSession(name: string): Promise<void> {
  // Best-effort; tmux exits non-zero if session does not exist.
  await tmux(["kill-session", "-t", name]);
}

async function tmuxCapture(name: string, lines: number): Promise<string> {
  const start = -Math.max(1, Math.trunc(lines));
  // -J: join wrapped lines so JSONL from Pi RPC remains parseable.
  const res = await tmux(["capture-pane", "-J", "-p", "-t", name, "-S", String(start)]);
  return res.stdout;
}

async function tmuxSendJson(name: string, value: unknown) {
  const line = JSON.stringify(value);
  await tmux(["send-keys", "-t", name, line, "Enter"]);
}

function parseJsonLines(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore parse failures.
    }
  }
  return out;
}

type PiStateSnapshot = {
  id: string;
  isStreaming: boolean;
  pendingMessageCount: number;
  messageCount: number;
  sessionId?: string;
  sessionFile?: string;
};

async function queryPiState(tmuxName: string): Promise<PiStateSnapshot | null> {
  const id = `state_${Date.now()}_${shortHash(crypto.randomUUID())}`;
  await tmuxSendJson(tmuxName, { id, type: "get_state" });

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const raw = await tmuxCapture(tmuxName, 120);
    const events = parseJsonLines(raw);
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i] as any;
      if (!evt || typeof evt !== "object") continue;
      if (evt.id !== id) continue;
      if (evt.type !== "response" || evt.command !== "get_state") continue;
      if (evt.success !== true) return null;
      const data = evt.data ?? {};
      return {
        id,
        isStreaming: data.isStreaming === true,
        pendingMessageCount:
          typeof data.pendingMessageCount === "number" ? Math.max(0, Math.trunc(data.pendingMessageCount)) : 0,
        messageCount: typeof data.messageCount === "number" ? Math.max(0, Math.trunc(data.messageCount)) : 0,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
      };
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}

async function tmuxPaneCwd(name: string): Promise<string | null> {
  const res = await tmux(["display-message", "-p", "-t", name, "#{pane_current_path}"]);
  const trimmed = res.stdout.trim();
  return trimmed ? trimmed : null;
}

async function tmuxSetEnv(name: string, key: string, value: string) {
  await tmux(["set-environment", "-t", name, key, value]);
}

async function tmuxShowEnv(name: string, key: string): Promise<string | null> {
  const res = await tmux(["show-environment", "-t", name, key]);
  const line = res.stdout.trim();
  if (!line) return null;
  if (line.startsWith("-")) return null;
  const idx = line.indexOf("=");
  if (idx < 0) return null;
  return line.slice(idx + 1);
}

function resolveAgentRootDirFromAgentDir(agentDir?: string): string | null {
  const raw = typeof agentDir === "string" ? agentDir.trim() : "";
  if (!raw) return null;
  return path.dirname(raw);
}

// Fallback for environments where config loading is unavailable/invalid.
// Default Clawdbot layout is: ~/.clawdbot/agents/<agentId>/...
function resolveAgentRootDirFromAgentId(agentId?: string): string | null {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return null;
  const root = path.join(homedir(), ".clawdbot", "agents", id);
  return existsSync(root) ? root : null;
}

function resolveAskpiDir(agentRootDir: string): string {
  const askpiDir = path.join(agentRootDir, "askpi");
  const legacyDir = path.join(agentRootDir, "coding-sessions");
  if (existsSync(askpiDir)) return askpiDir;
  if (existsSync(legacyDir)) return legacyDir;
  return askpiDir;
}

async function ensureAskpiDir(agentRootDir: string): Promise<void> {
  const askpiDir = path.join(agentRootDir, "askpi");
  const legacyDir = path.join(agentRootDir, "coding-sessions");

  if (existsSync(askpiDir)) return;

  if (existsSync(legacyDir)) {
    // Best-effort alias for existing installs (avoid breaking older Pi sessionDir paths).
    try {
      await fs.symlink(legacyDir, askpiDir);
      return;
    } catch {
      return;
    }
  }

  await fs.mkdir(askpiDir, { recursive: true });
}

function resolveRecordPath(agentRootDir: string, sessionKey: string): string {
  return path.join(resolveAskpiDir(agentRootDir), `${shortHash(sessionKey)}.json`);
}

function resolveAskpiArchiveDir(agentRootDir: string): string {
  return path.join(resolveAskpiDir(agentRootDir), "archive");
}

function resolveCodingSessionId(sessionKey: string): string {
  return `cs_${shortHash(sessionKey)}`;
}

function createCodingSessionId(sessionKey: string): string {
  const suffix = shortHash(`${Date.now()}-${crypto.randomUUID()}`);
  return `cs_${shortHash(sessionKey)}_${suffix}`;
}

function resolvePiSessionDir(agentRootDir: string, sessionKey: string): string {
  const id = shortHash(sessionKey);
  return path.join(resolveAskpiDir(agentRootDir), id, "pi-session");
}

function buildFreshPiArgs(params: { sessionDir: string; extensionPath: string; continueLast: boolean }): string[] {
  // `--continue` reuses the previous Pi session history within the sessionDir.
  // When we want a fresh context, omit it.
  return [
    "pi",
    "--mode",
    "rpc",
    ...(params.continueLast ? ["--continue"] : []),
    "--session-dir",
    params.sessionDir,
    "-e",
    params.extensionPath,
  ];
}

function resolveFreshPiSessionDir(agentRootDir: string, sessionKey: string): string {
  const base = resolvePiSessionDir(agentRootDir, sessionKey);
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}-fresh-${suffix}`;
}

const REMOVED_ASKPI_COMMANDS = new Set([
  "ensure",
  "inspect",
  "rehydrate",
  "list",
  "peek",
  "diagnose",
  "fix-delivery",
  "gc",
  "prune",
  "restore-all",
  "info",
  "attach",
  "tui",
]);

const REMOVED_ASKPI_ACTIONS = new Set([
  "ensure",
  "inspect",
  "rehydrate",
  "list",
  "peek",
  "diagnose",
  "fix-delivery",
  "gc",
  "prune",
  "restore-all",
]);

function renderAskpiHelpText(): string {
  return [
    "askpi",
    "",
    "One long-running Pi (RPC) session per chat/thread/topic.",
    "",
    "Commands:",
    "- /askpi help",
    "- /askpi status",
    "- /askpi new [/ABS/PATH]",
    "- /askpi <prompt>",
    "- /askpi stop",
    "- /askpi reset",
    "- /askpi handoff",
    "- /askpi resume",
    "",
    "Notes:",
    "- /askpi new archives any previous session and starts fresh.",
    "- /askpi reset keeps the same session id and restarts the coding runtime.",
  ].join("\n");
}

export function parseAskpiRawCommand(rawCommand: string):
  | { action: "help" | "status" | "new" | "stop" | "reset" | "handoff" | "resume" }
  | { action: "new"; cwd: string }
  | { action: "send"; message: string }
  | { error: string } {
  const trimmed = rawCommand.trim();
  if (!trimmed) return { action: "help" };

  const firstSpace = trimmed.search(/\s/);
  const verb = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();

  if (REMOVED_ASKPI_COMMANDS.has(verb)) {
    return { error: `Unknown /askpi command: ${verb}. Run /askpi help.` };
  }

  if (verb === "help" && !rest) return { action: "help" };
  if (verb === "status" && !rest) return { action: "status" };
  if (verb === "stop" && !rest) return { action: "stop" };
  if (verb === "reset" && !rest) return { action: "reset" };
  if (verb === "handoff" && !rest) return { action: "handoff" };
  if (verb === "resume" && !rest) return { action: "resume" };
  if (verb === "new") {
    if (!rest) return { action: "new" };
    if (rest.startsWith("/")) return { action: "new", cwd: rest };
  }

  return { action: "send", message: trimmed };
}

async function archiveAskpiRecord(params: {
  agentRootDir: string;
  sessionKey: string;
  record: CodingSessionRecordV1;
  reason: "new";
}): Promise<string> {
  const archiveDir = resolveAskpiArchiveDir(params.agentRootDir);
  await fs.mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(
    archiveDir,
    `${shortHash(params.sessionKey)}-${stamp}-${params.reason}.json`,
  );
  await writeJsonAtomic(archivePath, {
    archivedAt: Date.now(),
    sessionKey: params.sessionKey,
    reason: params.reason,
    record: params.record,
  });
  return archivePath;
}

function resolvePiExtensionPath(): string {
  const root = resolvePluginRootDir();
  if (root) {
    const tsPath = path.join(root, "pi", "clawd-notify.ts");
    if (existsSync(tsPath)) return tsPath;
    const jsPath = path.join(root, "pi", "clawd-notify.js");
    if (existsSync(jsPath)) return jsPath;
  }
  const legacyRoot = path.join(homedir(), ".clawdbot", "extensions", "askpi", "pi");
  const legacyTs = path.join(legacyRoot, "clawd-notify.ts");
  if (existsSync(legacyTs)) return legacyTs;
  const legacyJs = path.join(legacyRoot, "clawd-notify.js");
  return legacyJs;
}

function buildNotifyUrl(cfg: any, httpPath: string): string {
  const port = typeof cfg.gateway?.port === "number" ? cfg.gateway.port : 18789;
  const pathPart = normalizeHttpPath(httpPath);
  return `http://127.0.0.1:${port}${pathPart}`;
}

async function buildRecord(params: {
  agentId: string;
  agentRootDir: string;
  sessionKey: string;
  cwd: string;
  tmuxName: string;
  codingSessionId?: string;
  deliveryResolvers?: DeliveryResolverConfig[];
}): Promise<CodingSessionRecordV1> {
  const piSessionDir = resolvePiSessionDir(params.agentRootDir, params.sessionKey);
  const extensionPath = resolvePiExtensionPath();

  const piArgs = buildFreshPiArgs({
    sessionDir: piSessionDir,
    extensionPath,
    continueLast: true,
  });

  const now = Date.now();
  return {
    version: 1,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    codingSessionId: params.codingSessionId ?? createCodingSessionId(params.sessionKey),
    delivery:
      (await readSessionDeliveryHint({
        agentRootDir: params.agentRootDir,
        sessionKey: params.sessionKey,
        deliveryResolvers: params.deliveryResolvers,
      })) ??
      undefined,
    tmux: { name: params.tmuxName },
    cwd: params.cwd,
    pi: {
      sessionDir: piSessionDir,
      extensionPath,
      piArgs,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function ensureTmuxSession(params: {
  record: CodingSessionRecordV1;
  pluginCfg: Required<PluginConfig>;
}): Promise<{ created: boolean; exists: boolean }> {
  const name = params.record.tmux.name;
  const exists = await tmuxHasSession(name);
  if (exists) return { created: false, exists: true };

  await fs.mkdir(params.record.pi.sessionDir, { recursive: true });

  const cfg = loadGatewayConfig();
  const notifyUrl = buildNotifyUrl(cfg, params.pluginCfg.httpPath);
  const piAgentDir = resolveAskpiPiAgentDir();

  // IMPORTANT: create the tmux session with a shell (no command).
  // If we run `pi --mode rpc` as the session command, sending Ctrl+C will end
  // the only process and tmux will destroy the session. We want the session to
  // stay alive for handoff/resume flows.
  const tmuxArgs = ["new-session", "-d", "-s", name, "-c", params.record.cwd];
  const res = await tmux(tmuxArgs);
  if (res.code !== 0) {
    throw new Error(`tmux new-session failed: ${res.stderr || res.stdout || "unknown error"}`);
  }

  const envVars: Record<string, string> = {
    CLAWD_SESSION_KEY: params.record.sessionKey,
    CLAWD_AGENT_ID: params.record.agentId,
    CLAWD_ASKPI_SESSION_ID: params.record.codingSessionId,
    CLAWD_TMUX_SESSION: params.record.tmux.name,
    CLAWD_NOTIFY_URL: notifyUrl,
    CLAWD_NOTIFY_TOKEN: params.pluginCfg.token,
    CLAWD_PI_SESSION_DIR: params.record.pi.sessionDir,
    PI_CODING_AGENT_DIR: piAgentDir,
  };

  const cmdLine = [
    "env",
    ...Object.entries(envVars).map(([key, value]) => `${key}=${shellQuote(value)}`),
    ...params.record.pi.piArgs.map((arg) => shellQuote(arg)),
  ].join(" ");

  // Start Pi RPC inside the shell.
  await tmux(["send-keys", "-t", name, cmdLine, "Enter"]);

  // For rehydration.
  await tmuxSetEnv(name, "CLAWD_SESSION_KEY", params.record.sessionKey);
  await tmuxSetEnv(name, "CLAWD_AGENT_ID", params.record.agentId);
  await tmuxSetEnv(name, "CLAWD_ASKPI_SESSION_ID", params.record.codingSessionId);
  await tmuxSetEnv(name, "CLAWD_PI_SESSION_DIR", params.record.pi.sessionDir);
  await tmuxSetEnv(name, "PI_CODING_AGENT_DIR", piAgentDir);

  return { created: true, exists: false };
}

async function resolveAgentRootDirFromConfig(agentId: string): Promise<string | null> {
  const cfg = loadGatewayConfig();
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const entry = agents.find((a: any) => a?.id === agentId) as any;
  const agentDir = typeof entry?.agentDir === "string" ? entry.agentDir : "";
  return resolveAgentRootDirFromAgentDir(agentDir);
}

async function handleNotify(api: any, req: any, res: any): Promise<boolean> {
  const pluginCfg = resolvePluginConfig(api);
  const expectedPath = normalizeHttpPath(pluginCfg.httpPath);
  // Backward compatibility: older tmux sessions may still POST to the legacy path.
  const legacyPath = "/coding-sessions/notify";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== expectedPath && url.pathname !== legacyPath) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!pluginCfg.token || token !== pluginCfg.token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  const body = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024) {
        resolve("");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });

  let payload: any = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = {};
  }

  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  const eventId = typeof payload.eventId === "string" ? payload.eventId.trim() : "";
  const completionId = computeCompletionId(payload) ?? "";
  const piSessionId = typeof payload.piSessionId === "string" ? payload.piSessionId.trim() : undefined;
  const piSessionFile = typeof payload.piSessionFile === "string" ? payload.piSessionFile.trim() : undefined;
  const askpiSessionId =
    typeof payload.askpiSessionId === "string" && payload.askpiSessionId.trim()
      ? payload.askpiSessionId.trim()
      : undefined;

  if (!sessionKey || !eventId || !completionId) {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }

  const agentId = inferAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }
  const agentRootDir =
    resolveAgentRootDirFromAgentId(agentId) ?? (await resolveAgentRootDirFromConfig(agentId));
  if (!agentRootDir) {
    res.statusCode = 404;
    res.end("Unknown agent");
    return true;
  }

  const recordPath = resolveRecordPath(agentRootDir, sessionKey);

  const outcome = await withRecordLock(recordPath, async () => {
    const existing = await readJsonFile<CodingSessionRecordV1>(recordPath);
    const now = Date.now();

    // Refresh/normalize delivery hints on every notify so we don't get stuck with stale/invalid targets.
    const freshDelivery = await readSessionDeliveryHint({
      agentRootDir,
      sessionKey,
      deliveryResolvers: pluginCfg.deliveryResolvers,
    });
    const mergedDelivery =
      normalizeDeliveryHintForSessionKey(existing?.delivery ?? null, sessionKey) ??
      normalizeDeliveryHintForSessionKey(freshDelivery ?? null, sessionKey) ??
      normalizeDeliveryHintForSessionKey(inferDeliveryHintFromSessionKey(sessionKey) ?? null, sessionKey) ??
      undefined;

    // Exactly-once: if we already delivered this completionId, return OK.
    // Backward-compat: older records may only have lastCompletion.eventId; treat that as delivered
    // unless we have a recorded delivery error.
    const legacyDelivered =
      Boolean(existing?.lastCompletion?.eventId) &&
      existing?.lastCompletion?.eventId === eventId &&
      !existing?.lastDeliveryError;
    if (
      (existing?.lastDeliveredCompletionId && existing.lastDeliveredCompletionId === completionId) ||
      (!existing?.lastDeliveredCompletionId && legacyDelivered)
    ) {
      // Still update metadata best-effort (no delivery).
      const updated: CodingSessionRecordV1 = {
        ...(existing ?? {
          version: 1,
          sessionKey,
          agentId,
          codingSessionId: askpiSessionId ?? resolveCodingSessionId(sessionKey),
          tmux: {
            name:
              typeof payload.tmuxSession === "string" && payload.tmuxSession.trim()
                ? payload.tmuxSession.trim()
                : `${pluginCfg.tmuxPrefix}-${shortHash(sessionKey)}`,
          },
          cwd: typeof payload.cwd === "string" ? payload.cwd : "",
          pi: {
            sessionDir:
              typeof payload.piSessionDir === "string" && payload.piSessionDir.trim()
                ? payload.piSessionDir.trim()
                : resolvePiSessionDir(agentRootDir, sessionKey),
            sessionFile: piSessionFile,
            sessionId: piSessionId,
            extensionPath: resolvePiExtensionPath(),
            piArgs: [],
          },
          createdAt: now,
          updatedAt: now,
        }),
        delivery: mergedDelivery,
        pi: {
          ...(existing?.pi ?? {
            sessionDir:
              typeof payload.piSessionDir === "string" && payload.piSessionDir.trim()
                ? payload.piSessionDir.trim()
                : resolvePiSessionDir(agentRootDir, sessionKey),
            extensionPath: resolvePiExtensionPath(),
            piArgs: [],
          }),
          ...(piSessionId ? { sessionId: piSessionId } : {}),
          ...(piSessionFile ? { sessionFile: piSessionFile } : {}),
        },
        lastCompletion: { eventId, endedAt: now },
        lastNotify: { completionId, eventId, receivedAt: now },
        lastDeliveredCompletionId: completionId,
        updatedAt: now,
      } as CodingSessionRecordV1;
      await writeJsonAtomic(recordPath, updated);
      return { status: 200, body: "OK" };
    }

    const next: CodingSessionRecordV1 = existing
      ? {
          ...existing,
          delivery: mergedDelivery,
          pi: {
            ...existing.pi,
            ...(piSessionId ? { sessionId: piSessionId } : {}),
            ...(piSessionFile ? { sessionFile: piSessionFile } : {}),
          },
          inFlight: undefined,
          lastCompletion: { eventId, endedAt: now },
          lastNotify: { completionId, eventId, receivedAt: now },
          lastDeliveryAttemptAt: now,
          lastDeliveryError: undefined,
          updatedAt: now,
        }
      : {
          version: 1,
          sessionKey,
          agentId,
          codingSessionId: askpiSessionId ?? resolveCodingSessionId(sessionKey),
          delivery: mergedDelivery,
          tmux: {
            name:
              typeof payload.tmuxSession === "string" && payload.tmuxSession.trim()
                ? payload.tmuxSession.trim()
                : `${pluginCfg.tmuxPrefix}-${shortHash(sessionKey)}`,
          },
          cwd: typeof payload.cwd === "string" ? payload.cwd : "",
          pi: {
            sessionDir:
              typeof payload.piSessionDir === "string" && payload.piSessionDir.trim()
                ? payload.piSessionDir.trim()
                : resolvePiSessionDir(agentRootDir, sessionKey),
            sessionFile: piSessionFile,
            sessionId: piSessionId,
            extensionPath: resolvePiExtensionPath(),
            piArgs: [],
          },
          inFlight: undefined,
          lastCompletion: { eventId, endedAt: now },
          lastNotify: { completionId, eventId, receivedAt: now },
          lastDeliveryAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        };

    // Persist record before attempting delivery so we don't lose state if delivery crashes.
    await writeJsonAtomic(recordPath, next);

    const delivery = next.delivery;
    if (!delivery?.channel || !delivery?.to) {
      const msg = `[askpi] notify: missing delivery context for sessionKey=${safePreview(sessionKey, 80)} (cannot deliver completion message)`;
      api?.logger?.warn?.(msg);

      // Persist error so diagnose can show it.
      await writeJsonAtomic(recordPath, {
        ...next,
        lastDeliveryAttemptAt: Date.now(),
        lastDeliveryError: "missing delivery context",
      });
      return { status: 500, body: "Missing delivery context" };
    }

    api?.logger?.info?.(
      `[askpi] notify: will deliver completion to ${delivery.channel} ${delivery.to}`,
    );

    try {
      const finalText = await resolvePiFinalAssistantText({
        piSessionFile: next.pi.sessionFile,
        piSessionDir: next.pi.sessionDir,
      });
      const text =
        (finalText && finalText.trim()) || `✅ Pi finished (askpi: ${next.codingSessionId}).`;

      const deliveryResult = await deliverBestEffortOutboundText({
        delivery: {
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: (delivery.threadId ?? delivery.messageThreadId ?? null) as any,
        },
        text,
      });

      const delivered: CodingSessionRecordV1 = {
        ...next,
        lastDeliveredCompletionId: completionId,
        lastDeliveryAttemptAt: Date.now(),
        lastDeliveryError: undefined,
        lastDeliveryResult: {
          ...deliveryResult,
          deliveredAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      await writeJsonAtomic(recordPath, delivered);
      return { status: 200, body: "OK" };
    } catch (err) {
      const errorText = String(err);
      api?.logger?.warn?.(`[askpi] completion delivery failed: ${errorText}`);
      await writeJsonAtomic(recordPath, {
        ...next,
        lastDeliveryAttemptAt: Date.now(),
        lastDeliveryError: errorText,
        updatedAt: Date.now(),
      });
      return { status: 500, body: "Delivery failed" };
    }
  });

  res.statusCode = outcome.status;
  res.end(outcome.body);
  return true;
}

export default {
  id: "askpi",
  name: "askpi",
  description: "One Pi (RPC) tmux session per chat, with callbacks on completion.",
  configSchema: PluginConfigSchema,

  register: (api: any) => {
    pluginApi = api;
    pluginRootDir = typeof api?.source === "string" ? path.dirname(api.source) : null;
    const pluginCfg = resolvePluginConfig(api);

    api.registerHttpHandler((req: any, res: any) => handleNotify(api, req, res));

    // Optional: reduce session transcript bloat by stripping toolResult.details at persistence time.
    // This helps keep chat.history responsive in Control UI.
    if (typeof api.on === "function") {
      api.on(
        "tool_result_persist",
        (event: any) => {
          const msg = event?.message;
          if (!msg || typeof msg !== "object") return;
          if (msg.role !== "toolResult") return;
          if (!("details" in msg)) return;
          const { details: _details, ...rest } = msg;
          return { message: rest };
        },
        { priority: -10 },
      );
    }

    api.registerTool((ctx: any) => {
      return {
        name: "askpi",
        label: "askpi",
        description:
          "Manage a per-chat Pi RPC session. Commands: help, status, new, send, stop, reset, handoff, resume.",
        parameters: CodingSessionsToolSchema,
        execute: async (_toolCallId: string, args: any) => {
          const params = (args ?? {}) as Record<string, unknown>;

          const rawCommand = typeof params.command === "string" ? params.command.trim() : "";
          const invokedViaCommandDispatch = typeof params.commandName === "string" || typeof params.skillName === "string";

          if (invokedViaCommandDispatch && !rawCommand && params.action === undefined) {
            params.action = "help";
          }

          if (rawCommand.length > 0 && params.action === undefined) {
            const parsed = parseAskpiRawCommand(rawCommand);
            if ("error" in parsed) {
              return textResult(parsed.error, { ok: false, error: "unknown_command" });
            }
            params.action = parsed.action;
            if ("message" in parsed) params.message = parsed.message;
            if ("cwd" in parsed) params.cwd = parsed.cwd;
          }

          const actionRaw = String(readString(params, "action", { required: true }) ?? "");
          const action = actionRaw.trim().toLowerCase() as CodingSessionsToolAction;

          if (REMOVED_ASKPI_ACTIONS.has(actionRaw.trim().toLowerCase())) {
            return textResult(`Unknown /askpi command: ${actionRaw.trim()}. Run /askpi help.`, {
              ok: false,
              error: "unknown_command",
            });
          }

          if (action === "help") {
            return textResult(renderAskpiHelpText(), { ok: true, action: "help" });
          }

          const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
          if (!sessionKey) {
            return jsonResult({ ok: false, error: "askpi requires a chat sessionKey" });
          }

          const agentId = (typeof ctx.agentId === "string" && ctx.agentId.trim())
            ? ctx.agentId.trim()
            : inferAgentIdFromSessionKey(sessionKey);
          if (!agentId) {
            return jsonResult({ ok: false, error: `Unable to infer agentId from sessionKey=${safePreview(sessionKey, 80)}` });
          }

          const agentRootDir =
            resolveAgentRootDirFromAgentDir(ctx.agentDir) ??
            resolveAgentRootDirFromAgentId(agentId) ??
            (await resolveAgentRootDirFromConfig(agentId));
          if (!agentRootDir) {
            return jsonResult({ ok: false, error: `Unable to resolve agent root dir for agentId=${agentId}` });
          }

          await ensureAskpiDir(agentRootDir);

          const recordPath = resolveRecordPath(agentRootDir, sessionKey);

          if (action === "gc" || action === "prune") {
            const dryRun = params.dryRun === true;
            const now = Date.now();
            const olderThanDaysRaw = readNumber(params, "olderThanDays");
            const olderThanDaysCandidate = Math.trunc(olderThanDaysRaw ?? 30);
            // Safety: treat olderThanDays < 1 as "no pruning" (avoids the footgun where 0 deletes almost everything).
            const pruneEnabled = olderThanDaysCandidate >= 1;
            const olderThanDays = pruneEnabled ? olderThanDaysCandidate : 0;
            const cutoffMs = pruneEnabled ? now - olderThanDays * 24 * 60 * 60 * 1000 : null;

            await ensureAskpiDir(agentRootDir);
            const dir = resolveAskpiDir(agentRootDir);
            const entries = existsSync(dir) ? await fs.readdir(dir, { withFileTypes: true }) : [];

            const recordFiles = entries
              .filter((e) => e.isFile() && e.name.endsWith(".json"))
              .map((e) => path.join(dir, e.name));

            // Cache record reads so gc/prune can share the same view of inFlight sessions.
            const recordCache = new Map<string, CodingSessionRecordV1>();
            const inFlightHashes = new Set<string>();
            for (const filePath of recordFiles) {
              const rec = await readJsonFile<CodingSessionRecordV1>(filePath);
              if (!rec) continue;
              recordCache.set(filePath, rec);
              const hash = path.basename(filePath, ".json");
              if (rec.inFlight) inFlightHashes.add(hash);
            }

            let tmuxAvailable = true;
            let tmuxListError: string | null = null;
            let tmuxNames = new Set<string>();

            if (action === "gc") {
              const list = await tmux(["list-sessions", "-F", "#{session_name}"]);
              if (list.code !== 0) {
                tmuxAvailable = false;
                tmuxListError = (list.stderr || list.stdout || "").trim() ||
                  `tmux list-sessions failed (code ${list.code})`;
              } else {
                const names = list.stdout
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);
                tmuxNames = new Set(names);
              }
            }

            let recordsChecked = 0;
            let recordsUpdated = 0;
            let sessionsMissing = 0;
            let sessionsRecovered = 0;
            let staleInFlight = 0;

            const staleInFlightErrorPrefix = "tmux session missing while inFlight (detected by gc at ";
            const isStaleInFlightError = (value: unknown): value is string =>
              typeof value === "string" && value.startsWith(staleInFlightErrorPrefix);

            if (action === "gc" && tmuxAvailable) {
              for (const filePath of recordFiles) {
                const rec = recordCache.get(filePath) ?? (await readJsonFile<CodingSessionRecordV1>(filePath));
                if (!rec) continue;
                recordsChecked++;

                const tmuxName = typeof rec.tmux?.name === "string" ? rec.tmux.name.trim() : "";
                if (!tmuxName) continue;

                const exists = tmuxNames.has(tmuxName);
                const wantsMissingSince = !exists && rec.tmux.missingSince == null;
                const wantsRecover = exists && rec.tmux.missingSince != null;
                // Keep lastSeenAt meaningful: refresh it on *every* gc run where tmux exists.
                const wantsLastSeenUpdate = exists;
                // If tmux is missing while we still think there's an inFlight request, persist a durable marker.
                const wantsStaleInFlightMark = !exists && Boolean(rec.inFlight) && !rec.lastError;
                // Clear the gc-generated "stale inFlight" marker once tmux is back.
                const wantsClearStaleInFlightError = exists && isStaleInFlightError(rec.lastError);

                let next: CodingSessionRecordV1 | null = null;
                if (
                  wantsMissingSince ||
                  wantsRecover ||
                  wantsLastSeenUpdate ||
                  wantsStaleInFlightMark ||
                  wantsClearStaleInFlightError
                ) {
                  next = {
                    ...rec,
                    tmux: {
                      ...rec.tmux,
                      ...(exists
                        ? { lastSeenAt: now, missingSince: undefined }
                        : { missingSince: rec.tmux.missingSince ?? now }),
                    },
                    ...(wantsStaleInFlightMark
                      ? {
                          lastError: `tmux session missing while inFlight (detected by gc at ${new Date(now).toISOString()})`,
                        }
                      : {}),
                    updatedAt: now,
                  };
                }

                if (!exists) sessionsMissing++;
                if (wantsRecover) sessionsRecovered++;
                if (wantsStaleInFlightMark) staleInFlight++;

                if (next) {
                  if (!dryRun) {
                    await withRecordLock(filePath, async () => {
                      // Re-read within lock to avoid clobbering concurrent updates.
                      const current = (await readJsonFile<CodingSessionRecordV1>(filePath)) ?? rec;
                      const merged: CodingSessionRecordV1 = {
                        ...current,
                        tmux: {
                          ...current.tmux,
                          ...next!.tmux,
                        },
                        ...(next!.lastError && !current.lastError ? { lastError: next!.lastError } : {}),
                        updatedAt: next!.updatedAt,
                      };

                      if (wantsClearStaleInFlightError && isStaleInFlightError(current.lastError)) {
                        delete merged.lastError;
                      }

                      await writeJsonAtomic(filePath, merged);
                    });
                  }
                  recordsUpdated++;
                }
              }
            }

            // Prune old Pi session JSONL under: ~/.clawdbot/agents/<agentId>/.../pi-session*
            // Safety measures:
            // - If olderThanDays < 1, pruning is disabled (to avoid footguns).
            // - Skip pruning for sessions that are currently inFlight.
            // - Always keep the newest .jsonl per pi-session dir.
            let jsonlChecked = 0;
            let jsonlPruned = 0;
            let jsonlKeptNewest = 0;
            let sessionDirsSkippedActive = 0;

            if (pruneEnabled && cutoffMs != null) {
              const sessionDirs = entries.filter((e) => e.isDirectory() && /^[0-9a-f]{12}$/i.test(e.name));
              for (const d of sessionDirs) {
                if (inFlightHashes.has(d.name)) {
                  sessionDirsSkippedActive++;
                  continue;
                }

                const sessionRoot = path.join(dir, d.name);
                const inner = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
                const piDirs = inner.filter((e) => e.isDirectory() && e.name.startsWith("pi-session"));
                for (const piDirEnt of piDirs) {
                  const piDir = path.join(sessionRoot, piDirEnt.name);
                  const files = await fs.readdir(piDir, { withFileTypes: true }).catch(() => []);

                  const jsonl = await Promise.all(
                    files
                      .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
                      .map(async (f) => {
                        const fp = path.join(piDir, f.name);
                        const st = await fs.stat(fp).catch(() => null);
                        if (!st) return null;
                        return { fp, mtimeMs: st.mtimeMs };
                      }),
                  );

                  const entriesJsonl = jsonl.filter(Boolean) as Array<{ fp: string; mtimeMs: number }>;
                  if (entriesJsonl.length === 0) continue;

                  // Keep the newest file even if it's older than cutoff.
                  const newest = entriesJsonl.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
                  jsonlKeptNewest++;

                  for (const item of entriesJsonl) {
                    jsonlChecked++;

                    if (item.fp === newest.fp) continue;
                    if (item.mtimeMs >= cutoffMs) continue;

                    jsonlPruned++;
                    if (!dryRun) {
                      await fs.unlink(item.fp).catch(() => undefined);
                    }
                  }
                }
              }
            }

            return jsonResult({
              ok: true,
              action,
              dryRun,
              pruneEnabled,
              olderThanDays,
              cutoffMs,
              cutoffIso: cutoffMs != null ? new Date(cutoffMs).toISOString() : null,
              ...(action === "gc"
                ? {
                    tmuxAvailable,
                    tmuxListError,
                    tmuxReconcileSkipped: !tmuxAvailable,
                  }
                : {}),
              recordsChecked,
              // In dryRun mode, counts below are "would" counts. Provide both to avoid confusion.
              recordsUpdated: dryRun ? 0 : recordsUpdated,
              recordsWouldUpdate: recordsUpdated,
              sessionsMissing,
              sessionsRecovered,
              staleInFlight,
              jsonlChecked,
              jsonlPruned: dryRun ? 0 : jsonlPruned,
              jsonlWouldPrune: jsonlPruned,
              jsonlKeptNewest,
              sessionDirsSkippedActive,
            });
          }

          if (action === "list") {
            await ensureAskpiDir(agentRootDir);
            const dir = resolveAskpiDir(agentRootDir);
            const entries = existsSync(dir) ? await fs.readdir(dir) : [];
            const files = entries.filter((f) => f.endsWith(".json"));
            const records = await Promise.all(
              files.map(async (f) => {
                const rec = await readJsonFile<CodingSessionRecordV1>(path.join(dir, f));
                if (!rec) return null;
                return {
                  askpiSessionId: rec.codingSessionId,
                  tmux: rec.tmux.name,
                  cwd: rec.cwd,
                  inFlight: Boolean(rec.inFlight),
                  lastCompletion: rec.lastCompletion?.endedAt,
                };
              }),
            );
            return jsonResult({ ok: true, sessions: records.filter(Boolean) });
          }

          if (action === "rehydrate") {
            const prefix = pluginCfg.tmuxPrefix;
            const list = await tmux(["list-sessions", "-F", "#{session_name}"]);
            const names = list.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .filter((n) => n.startsWith(`${prefix}-`));

            const restored: Array<{ tmux: string; sessionKey?: string; agentId?: string; recordPath?: string }> = [];

            for (const name of names) {
              const sk = await tmuxShowEnv(name, "CLAWD_SESSION_KEY");
              if (!sk) continue;
              const aId = (await tmuxShowEnv(name, "CLAWD_AGENT_ID")) ?? inferAgentIdFromSessionKey(sk);
              if (!aId) continue;
              const root = await resolveAgentRootDirFromConfig(aId);
              if (!root) continue;
              const rp = resolveRecordPath(root, sk);
              const existing = await readJsonFile<CodingSessionRecordV1>(rp);
              if (existing) {
                restored.push({ tmux: name, sessionKey: sk, agentId: aId, recordPath: rp });
                continue;
              }
              const piDir = (await tmuxShowEnv(name, "CLAWD_PI_SESSION_DIR")) ?? resolvePiSessionDir(root, sk);
              const cwd = (await tmuxPaneCwd(name)) ?? "";
              const now = Date.now();
              const rec: CodingSessionRecordV1 = {
                version: 1,
                sessionKey: sk,
                agentId: aId,
                codingSessionId: resolveCodingSessionId(sk),
                tmux: { name },
                cwd,
                pi: {
                  sessionDir: piDir,
                  extensionPath: resolvePiExtensionPath(),
                  piArgs: [],
                },
                createdAt: now,
                updatedAt: now,
              };
              await writeJsonAtomic(rp, rec);
              restored.push({ tmux: name, sessionKey: sk, agentId: aId, recordPath: rp });
            }

            return jsonResult({ ok: true, restored });
          }

          if (action === "restore-all") {
            // Recreate tmux + Pi RPC sessions for all known records.
            // Useful after host reboot where tmux sessions are gone but records + Pi session dirs remain.
            const dryRun = readBoolean(params, "dryRun") ?? false;
            await ensureAskpiDir(agentRootDir);
            const askpiDir = resolveAskpiDir(agentRootDir);

            let recordFiles: string[] = [];
            try {
              const entries = await fs.readdir(askpiDir, { withFileTypes: true });
              recordFiles = entries
                .filter((e) => e.isFile() && e.name.endsWith(".json"))
                .map((e) => e.name)
                .sort();
            } catch {
              return jsonResult({ ok: false, error: `Unable to read askpi state dir: ${askpiDir}` });
            }

            const restored: Array<{ record: string; tmux: string; cwd: string; piSessionDir: string }> = [];
            const alreadyRunning: Array<{ record: string; tmux: string }> = [];
            const skipped: Array<{ record: string; reason: string }> = [];

            for (const fileName of recordFiles) {
              const rp = path.join(askpiDir, fileName);
              const outcome = await withRecordLock(rp, async () => {
                const rec = await readJsonFile<CodingSessionRecordV1>(rp);
                if (!rec) return { kind: "skipped" as const, reason: "record unreadable" };

                const name = typeof rec.tmux?.name === "string" ? rec.tmux.name.trim() : "";
                if (!name) return { kind: "skipped" as const, reason: "record missing tmux name" };

                if (await tmuxHasSession(name)) {
                  return { kind: "already" as const, tmux: name };
                }

                // Never resurrect active/busy sessions automatically.
                if (rec.inFlight) {
                  return { kind: "skipped" as const, reason: "record is inFlight" };
                }

                // Validate/normalize cwd before starting tmux. If invalid, tmux will fall back.
                let cwd = typeof rec.cwd === "string" ? rec.cwd.trim() : "";
                if (!cwd.startsWith("/")) {
                  return { kind: "skipped" as const, reason: `invalid cwd: ${cwd || "<empty>"}` };
                }
                try {
                  const st = await fs.stat(cwd);
                  if (!st.isDirectory()) {
                    return { kind: "skipped" as const, reason: `cwd is not a directory: ${cwd}` };
                  }
                  cwd = await fs.realpath(cwd);
                } catch {
                  return { kind: "skipped" as const, reason: `cwd does not exist: ${cwd}` };
                }

                // Ensure Pi args are present and set to continue (preserve history).
                const sessionKeyForRecord = rec.sessionKey;
                const extensionPath = resolvePiExtensionPath();
                const sessionDir =
                  (typeof rec.pi?.sessionDir === "string" && rec.pi.sessionDir.trim()
                    ? rec.pi.sessionDir.trim()
                    : resolvePiSessionDir(agentRootDir, sessionKeyForRecord));
                await fs.mkdir(sessionDir, { recursive: true });

                const updated: CodingSessionRecordV1 = {
                  ...rec,
                  cwd,
                  pi: {
                    ...(rec.pi ?? { sessionDir, extensionPath, piArgs: [] }),
                    sessionDir,
                    extensionPath,
                    piArgs: buildFreshPiArgs({ sessionDir, extensionPath, continueLast: true }),
                  },
                  // Clear stale transient state.
                  inFlight: undefined,
                  updatedAt: Date.now(),
                };

                if (!dryRun) {
                  const tmuxResult = await ensureTmuxSession({ record: updated, pluginCfg });
                  await writeJsonAtomic(rp, updated);
                  if (!tmuxResult.created && !tmuxResult.exists) {
                    // Shouldn't happen, but be defensive.
                    return { kind: "skipped" as const, reason: "tmux ensure returned unexpected result" };
                  }
                }

                return {
                  kind: "restored" as const,
                  tmux: name,
                  cwd,
                  piSessionDir: sessionDir,
                };
              });

              if (outcome.kind === "restored") {
                restored.push({ record: fileName, tmux: outcome.tmux, cwd: outcome.cwd, piSessionDir: outcome.piSessionDir });
              } else if (outcome.kind === "already") {
                alreadyRunning.push({ record: fileName, tmux: outcome.tmux });
              } else {
                skipped.push({ record: fileName, reason: outcome.reason });
              }
            }

            return jsonResult({
              ok: true,
              action: "restore-all",
              dryRun,
              recordsTotal: recordFiles.length,
              restoredCount: restored.length,
              alreadyRunningCount: alreadyRunning.length,
              skippedCount: skipped.length,
              restored,
              alreadyRunning,
              skipped,
            });
          }

          if (action === "new") {
            return await withRecordLock(recordPath, async () => {
            const existingRecord = await readJsonFile<CodingSessionRecordV1>(recordPath);
            let cwd = String(readString(params, "cwd") ?? existingRecord?.cwd ?? "");
            if (!cwd) {
              return jsonResult({
                ok: false,
                error: "cwd required for first run. Use: /askpi new /ABS/PATH",
              });
            }
            if (!cwd.startsWith("/")) {
              return jsonResult({ ok: false, error: "cwd must be an absolute path" });
            }
            try {
              const st = await fs.stat(cwd);
              if (!st.isDirectory()) {
                return jsonResult({ ok: false, error: `cwd is not a directory: ${cwd}` });
              }
              cwd = await fs.realpath(cwd);
            } catch {
              return jsonResult({ ok: false, error: `cwd does not exist: ${cwd}` });
            }

            let archivePath: string | null = null;
            if (existingRecord) {
              archivePath = await archiveAskpiRecord({
                agentRootDir,
                sessionKey,
                record: existingRecord,
                reason: "new",
              });
              const existingName = typeof existingRecord.tmux?.name === "string"
                ? existingRecord.tmux.name.trim()
                : "";
              if (existingName && (await tmuxHasSession(existingName))) {
                await tmuxKillSession(existingName);
              }
            }

            const record = await buildRecord({
              agentId,
              agentRootDir,
              sessionKey,
              cwd,
              tmuxName: `${pluginCfg.tmuxPrefix}-${shortHash(sessionKey)}`,
              codingSessionId: createCodingSessionId(sessionKey),
              deliveryResolvers: pluginCfg.deliveryResolvers,
            });

            const tmuxResult = await ensureTmuxSession({ record, pluginCfg });
            await writeJsonAtomic(recordPath, record);

            return jsonResult({
              ok: true,
              action: "new",
              created: tmuxResult.created,
              tmux: record.tmux.name,
              cwd,
              codingSessionId: record.codingSessionId,
              piSessionDir: record.pi.sessionDir,
              archivedPrevious: Boolean(existingRecord),
              archivePath,
            });
          });
          }

          if (action === "reset") {
            return await withRecordLock(recordPath, async () => {
            // Reset = keep the same session id, but restart runtime state and Pi session files.
            const existing = await readJsonFile<CodingSessionRecordV1>(recordPath);
            if (!existing) {
              return jsonResult({
                ok: false,
                error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
              });
            }

            const cwdRaw = readString(params, "cwd");
            if (cwdRaw) {
              return jsonResult({
                ok: false,
                error: "reset does not accept cwd. Use /askpi new [/ABS/PATH] to change directories.",
              });
            }

            // Validate existing cwd before stopping the active session.
            let resolvedCwd = existing.cwd;
            try {
              const st = await fs.stat(resolvedCwd);
              if (!st.isDirectory()) {
                return jsonResult({
                  ok: false,
                  error: `Current cwd is not a directory: ${resolvedCwd}. Run /askpi new /ABS/PATH.`,
                });
              }
              resolvedCwd = await fs.realpath(resolvedCwd);
            } catch {
              return jsonResult({
                ok: false,
                error: `Current cwd does not exist: ${resolvedCwd}. Run /askpi new /ABS/PATH.`,
              });
            }

            // Stop tmux session if present.
            const name = existing.tmux.name;
            const existed = await tmuxHasSession(name);
            if (existed) {
              await tmuxKillSession(name);
            }

            // Create a new Pi session dir and start without --continue.
            const extensionPath = resolvePiExtensionPath();
            const freshSessionDir = resolveFreshPiSessionDir(agentRootDir, sessionKey);
            await fs.mkdir(freshSessionDir, { recursive: true });

            existing.cwd = resolvedCwd;
            existing.pi.sessionDir = freshSessionDir;
            existing.pi.extensionPath = extensionPath;
            existing.pi.piArgs = buildFreshPiArgs({
              sessionDir: freshSessionDir,
              extensionPath,
              continueLast: false,
            });
            existing.pi.sessionFile = undefined;
            existing.pi.sessionId = undefined;
            existing.inFlight = undefined;
            existing.updatedAt = Date.now();

            // Ensure we have a usable delivery hint for prompt log + callbacks.
            existing.delivery =
              normalizeDeliveryHintForSessionKey(existing.delivery ?? null, sessionKey) ??
              (await readSessionDeliveryHint({
                agentRootDir,
                sessionKey,
                deliveryResolvers: pluginCfg.deliveryResolvers,
              })) ??
              undefined;

            const tmuxResult = await ensureTmuxSession({ record: existing, pluginCfg });
            await writeJsonAtomic(recordPath, existing);

            return jsonResult({
              ok: true,
              action: "reset",
              killedOldTmux: existed,
              tmux: name,
              cwd: existing.cwd,
              piSessionDir: existing.pi.sessionDir,
              created: tmuxResult.created,
            });
          });
          }

          const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
          if (!record) {
            return jsonResult({
              ok: false,
              error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
            });
          }

          if (action === "fix-delivery") {
            return await withRecordLock(recordPath, async () => {
              const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
              if (!record) {
                return jsonResult({
                  ok: false,
                  error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
                });
              }

              const fresh = await readSessionDeliveryHint({
                agentRootDir,
                sessionKey,
                deliveryResolvers: pluginCfg.deliveryResolvers,
              });
              const fixed =
                normalizeDeliveryHintForSessionKey(record.delivery ?? null, sessionKey) ??
                normalizeDeliveryHintForSessionKey(fresh ?? null, sessionKey) ??
                undefined;
              record.delivery = fixed;
              record.updatedAt = Date.now();
              await writeJsonAtomic(recordPath, record);
              return jsonResult({ ok: true, action: "fix-delivery", delivery: record.delivery });
            });
          }

          if (action === "peek") {
            const name = record.tmux.name;
            const exists = await tmuxHasSession(name);
            const paneCwd = exists ? await tmuxPaneCwd(name) : null;
            const piState = exists ? await queryPiState(name) : null;
            const peek = await resolvePiPeekActivity({
              piSessionFile: record.pi.sessionFile,
              piSessionDir: record.pi.sessionDir,
            });

            const lines: string[] = [];
            lines.push(`Peek (${record.codingSessionId})`);
            lines.push(`tmux: ${name}${exists ? "" : " (missing)"}`);
            if (paneCwd) lines.push(`pane cwd: ${paneCwd}`);
            if (record.cwd) lines.push(`record cwd: ${record.cwd}`);
            if (piState) {
              lines.push(
                `pi: streaming=${String(piState.isStreaming)} pending=${String(piState.pendingMessageCount)} sessionId=${piState.sessionId ?? ""}`.trim(),
              );
            } else {
              lines.push(`pi: (no RPC state)`);
            }
            if (record.inFlight) {
              lines.push(
                `inFlight: ${record.inFlight.mode} sentAt=${new Date(record.inFlight.sentAt).toISOString()} preview=${record.inFlight.messagePreview}`,
              );
            }
            if (peek?.lastToolName) lines.push(`last tool: ${peek.lastToolName}`);
            if (peek?.lastEventType) lines.push(`last event: ${peek.lastEventType}`);
            if (peek?.lastAssistantText) {
              lines.push("---");
              lines.push(peek.lastAssistantText);
            }

            return textResult(lines.join("\n"), {
              ok: true,
              action: "peek",
              tmux: name,
              exists,
              paneCwd,
              piState,
              peek,
            });
          }

          if (action === "status") {
            const name = record.tmux.name;
            const exists = await tmuxHasSession(name);
            const paneCwd = exists ? await tmuxPaneCwd(name) : null;
            const piState = exists ? await queryPiState(name) : null;
            const peek = await resolvePiPeekActivity({
              piSessionFile: record.pi.sessionFile,
              piSessionDir: record.pi.sessionDir,
            });

            const d = record.delivery;
            const threadId = (d?.threadId ?? d?.messageThreadId) as any;
            const socketConfig = resolveAskpiTmuxSocketConfig();
            const attachCmd = buildAskpiTmuxAttachCommand(name);
            const lines: string[] = [];
            lines.push(`Status (${record.codingSessionId})`);
            lines.push(`sessionKey: ${record.sessionKey}`);
            lines.push(`tmux: ${name}${exists ? "" : " (missing)"}`);
            lines.push(`tmux socket: ${socketConfig.displayArgs}`);
            lines.push(`tmux attach: ${attachCmd}`);
            if (record.tmux?.missingSince) {
              lines.push(`tmux missingSince: ${new Date(record.tmux.missingSince).toISOString()}`);
            }
            if (record.tmux?.lastSeenAt) {
              lines.push(`tmux lastSeenAt: ${new Date(record.tmux.lastSeenAt).toISOString()}`);
            }
            if (paneCwd) lines.push(`pane cwd: ${paneCwd}`);
            if (record.cwd) lines.push(`record cwd: ${record.cwd}`);
            lines.push(
              `delivery: ${d?.channel ?? ""} ${d?.to ?? ""}${threadId != null ? ` threadId=${String(threadId)}` : ""}`.trim(),
            );
            if (record.lastNotify?.completionId) {
              lines.push(
                `last notify: ${record.lastNotify.completionId} at ${new Date(record.lastNotify.receivedAt).toISOString()}`,
              );
            }
            if (record.lastDeliveredCompletionId) {
              lines.push(`last delivered: ${record.lastDeliveredCompletionId}`);
            }
            if (record.lastDeliveryResult) {
              const r = record.lastDeliveryResult;
              const parts = [`last delivery result: ${r.channel}`];
              if (r.messageId) parts.push(`messageId=${r.messageId}`);
              if (r.channelId) parts.push(`channelId=${r.channelId}`);
              if (r.chatId) parts.push(`chatId=${r.chatId}`);
              if (r.threadId != null) parts.push(`threadId=${String(r.threadId)}`);
              if (r.deliveredAt) parts.push(`at=${new Date(r.deliveredAt).toISOString()}`);
              lines.push(parts.join(" "));
            }
            if (record.lastDeliveryError) {
              lines.push(`last delivery error: ${truncateForPeek(record.lastDeliveryError, 200)}`);
            }
            if (record.lastError) {
              lines.push(`last error: ${truncateForPeek(record.lastError, 200)}`);
            }
            if (record.inFlight) {
              lines.push(
                `inFlight: ${record.inFlight.mode} reqId=${record.inFlight.reqId ?? ""} sentAt=${new Date(record.inFlight.sentAt).toISOString()}`.trim(),
              );
            }
            if (piState) {
              lines.push(
                `pi: streaming=${String(piState.isStreaming)} pending=${String(piState.pendingMessageCount)} messageCount=${String(piState.messageCount)} sessionFile=${piState.sessionFile ?? ""}`.trim(),
              );
            } else {
              lines.push(`pi: (no RPC state)`);
            }
            // Diagnose should not leak recent assistant text into the chat/tool output.
            // Keep metadata only.
            const peekSafe = peek ? { ...peek, lastAssistantText: undefined } : null;

            return textResult(lines.join("\n"), {
              ok: true,
              action: "status",
              tmux: name,
              exists,
              paneCwd,
              piState,
              record,
              peek: peekSafe,
            });
          }

          if (action === "stop") {
            return await withRecordLock(recordPath, async () => {
              const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
              if (!record) {
                return jsonResult({
                  ok: false,
                  error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
                });
              }

              const name = record.tmux.name;
              const existed = await tmuxHasSession(name);
              if (existed) {
                await tmux(["kill-session", "-t", name]);
              }
              record.inFlight = undefined;
              record.updatedAt = Date.now();
              await writeJsonAtomic(recordPath, record);
              return jsonResult({ ok: true, action: "stop", tmux: name, existed });
            });
          }

          if (action === "inspect") {
            return await withRecordLock(recordPath, async () => {
              const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
              if (!record) {
                return jsonResult({
                  ok: false,
                  error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
                });
              }

              const lines = Math.trunc(readNumber(params, "lines") ?? 120);
              const name = record.tmux.name;
              const exists = await tmuxHasSession(name);
              const paneCwd = exists ? await tmuxPaneCwd(name) : null;
              const piState = exists ? await queryPiState(name) : null;
              const log = exists ? await tmuxCapture(name, lines) : "";

              // Opportunistically refresh stored Pi session pointers.
              if (piState?.sessionId) record.pi.sessionId = piState.sessionId;
              if (piState?.sessionFile) record.pi.sessionFile = piState.sessionFile;
              record.updatedAt = Date.now();
              await writeJsonAtomic(recordPath, record);
              return jsonResult({
                ok: true,
                action: "inspect",
                tmux: name,
                exists,
                cwd: record.cwd,
                paneCwd,
                piState,
                inFlight: record.inFlight,
                pi: {
                  sessionDir: record.pi.sessionDir,
                  sessionFile: record.pi.sessionFile,
                  sessionId: record.pi.sessionId,
                },
                tail: log,
              });
            });
          }

          if (action === "send") {
            const message = String(readString(params, "message", { required: true }) ?? "");

            const outcome = await withRecordLock(recordPath, async () => {
              const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
              if (!record) {
                return {
                  result: jsonResult({
                    ok: false,
                    error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
                  }),
                  promptLog: null as null | {
                    delivery: {
                      channel: string;
                      to: string;
                      accountId?: string;
                      threadId?: string | number | null;
                    };
                    text: string;
                  },
                };
              }

              const name = record.tmux.name;
              const exists = await tmuxHasSession(name);
              if (!exists) {
                return {
                  result: jsonResult({
                    ok: false,
                    error: `tmux session not running: ${name}. Run /askpi new or /askpi reset.`,
                  }),
                  promptLog: null,
                };
              }

              // Simplified behavior (no interrupts):
              // - If Pi is streaming: queue a follow-up message.
              // - If Pi is idle: start a prompt immediately.
              // We still query state so we can pick the right RPC command.
              const piState = await queryPiState(name);
              if (!piState) {
                return {
                  result: jsonResult({
                    ok: false,
                    error:
                      "Pi is not responding in RPC mode in this tmux session. If you are currently in Pi TUI (handoff), quit it and run /askpi resume.",
                    tmux: name,
                  }),
                  promptLog: null,
                };
              }
              const isStreaming = piState?.isStreaming === true;

              // If Pi is idle and there are no pending messages, clear stale inFlight state.
              if (piState && !piState.isStreaming && piState.pendingMessageCount === 0) {
                record.inFlight = undefined;
              }

              // Refresh stored Pi session pointers.
              if (piState?.sessionId) record.pi.sessionId = piState.sessionId;
              if (piState?.sessionFile) record.pi.sessionFile = piState.sessionFile;

              const now = Date.now();
              const reqId = `req_${now}_${shortHash(crypto.randomUUID())}`;

              const mode: "prompt" | "follow_up" = isStreaming ? "follow_up" : "prompt";

              if (mode === "follow_up") {
                await tmuxSendJson(name, { id: reqId, type: "follow_up", message });
              } else {
                await tmuxSendJson(name, { id: reqId, type: "prompt", message });
              }

              record.inFlight = {
                mode,
                reqId,
                sentAt: now,
                messagePreview: safePreview(message),
              };
              record.updatedAt = now;

              // Compute + store delivery hint.
              const deliveryForLog =
                normalizeDeliveryHintForSessionKey(record.delivery ?? null, sessionKey) ??
                inferDeliveryHintFromSessionKey(sessionKey);
              if (deliveryForLog) {
                record.delivery = deliveryForLog;
              }

              await writeJsonAtomic(recordPath, record);

              const payload = {
                ok: true,
                action: "send",
                mode,
                tmux: name,
                reqId,
                piState,
              };

              const result = invokedViaCommandDispatch
                ? textResult(
                    mode === "follow_up"
                      ? "🧵 Pi is busy; queued your message as a follow-up. I’ll post the result when it finishes."
                      : "🧵 Sent to Pi. I’ll post the result when it finishes.",
                    payload,
                  )
                : jsonResult(payload);

              const promptLog =
                deliveryForLog?.channel === "discord" &&
                typeof deliveryForLog.to === "string" &&
                /^channel:\d+$/.test(deliveryForLog.to)
                  ? {
                      delivery: {
                        channel: deliveryForLog.channel,
                        to: deliveryForLog.to,
                        accountId: deliveryForLog.accountId,
                        threadId: (deliveryForLog.threadId ?? deliveryForLog.messageThreadId ?? null) as any,
                      },
                      text: `🧾 /askpi prompt:\n=========\n${truncateForPromptLog(message)}\n=========`,
                    }
                  : null;

              return { result, promptLog };
            });

            // Best-effort only; never fail the tool call.
            if (outcome.promptLog) {
              try {
                await deliverBestEffortOutboundText({
                  delivery: outcome.promptLog.delivery,
                  text: outcome.promptLog.text,
                });
              } catch {
                // ignore
              }
            }

            return outcome.result;
          }

          if (action === "handoff") {
            return await withRecordLock(recordPath, async () => {
              const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
              if (!record) {
                return jsonResult({
                  ok: false,
                  error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
                });
              }

              const name = record.tmux.name;
              const existed = await tmuxHasSession(name);
              const piState = existed ? await queryPiState(name) : null;
              const isStreaming = piState?.isStreaming === true;
              if (isStreaming) {
                return textResult(
                  `Refusing handoff: Pi is currently streaming in tmux session ${name}. Wait for it to finish, then retry /askpi handoff.`,
                );
              }

              // Clean handoff model:
              // - kill any existing tmux session (and any running Pi RPC)
              // - recreate a fresh tmux session with the same name
              // - start Pi TUI inside it
              if (existed) {
                await tmuxKillSession(name);
              }
              const created = await tmux(["new-session", "-d", "-s", name, "-c", record.cwd]);
              if (created.code !== 0) {
                return jsonResult({
                  ok: false,
                  error: `tmux new-session failed: ${created.stderr || created.stdout || "unknown error"}`,
                });
              }

              const sessionDir = record.pi.sessionDir;
              const sessionFile = record.pi.sessionFile;
              const attachCmd = buildAskpiTmuxAttachCommand(name);
              const piAgentDir = resolveAskpiPiAgentDir();
              await tmuxSetEnv(name, "PI_CODING_AGENT_DIR", piAgentDir);
              const tuiCmdCore = `pi --session-dir ${sessionDir} --continue`;
              const tuiCmd = `env PI_CODING_AGENT_DIR=${shellQuote(piAgentDir)} ${tuiCmdCore}`;
              const tuiCmdExact = sessionFile
                ? `env PI_CODING_AGENT_DIR=${shellQuote(piAgentDir)} pi --session ${sessionFile}`
                : undefined;
              const resumeCmd = "/askpi resume";

              // Kick off Pi TUI inside the new tmux session. When the user attaches they'll be in Pi.
              await tmux(["send-keys", "-t", name, tuiCmd, "Enter"]);

              // Clear inFlight (we intentionally stopped any in-progress work).
              record.inFlight = undefined;
              record.updatedAt = Date.now();
              await writeJsonAtomic(recordPath, record);

              const instructions = [
                `1) Attach to the tmux session (Pi TUI is already started):`,
                `   ${attachCmd}`,
                ...(tuiCmdExact ? [`   (or exact file: ${tuiCmdExact})`] : []),
                `2) When done in Pi, quit Pi TUI (Ctrl+C) to return to your shell.`,
                `3) Back in Discord, run:`,
                `   ${resumeCmd}`,
              ].join("\n");

              const header = `Handoff for ${name}`;
              const prepLine = existed
                ? "Restarted tmux session (killed old session + created a fresh one)."
                : "Created new tmux session.";
              const out = [header, prepLine, "", instructions].join("\n");
              return textResult(out, {
                ok: true,
                action: "handoff",
                tmux: name,
                previousPiState: piState,
                commands: {
                  attach: attachCmd,
                  tui: tuiCmd,
                  ...(tuiCmdExact ? { tuiExact: tuiCmdExact } : {}),
                  resume: resumeCmd,
                },
                instructions,
              });
            });
          }

          if (action === "resume") {
            return await withRecordLock(recordPath, async () => {
              const record = await readJsonFile<CodingSessionRecordV1>(recordPath);
              if (!record) {
                return jsonResult({
                  ok: false,
                  error: "No askpi session for this chat. Run /askpi new [/ABS/PATH] first.",
                });
              }

              const name = record.tmux.name;
              const existed = await tmuxHasSession(name);
              if (existed) {
                // Always restart cleanly: kill the tmux session so we definitely exit Pi TUI
                // and any stale processes, then recreate with the same name.
                await tmuxKillSession(name);
              }

              // Recreate and start Pi RPC.
              // Also normalize the notify extension path in case this record predates a rename.
              const extensionPath = resolvePiExtensionPath();
              const sessionDir =
                (typeof record.pi?.sessionDir === "string" && record.pi.sessionDir.trim())
                  ? record.pi.sessionDir.trim()
                  : resolvePiSessionDir(agentRootDir, sessionKey);
              await fs.mkdir(sessionDir, { recursive: true });
              record.pi.sessionDir = sessionDir;
              record.pi.extensionPath = extensionPath;
              record.pi.piArgs = buildFreshPiArgs({ sessionDir, extensionPath, continueLast: true });

              const pluginCfg = resolvePluginConfig(api);
              await ensureTmuxSession({ record, pluginCfg });

              // Confirm RPC is alive.
              const piState = await queryPiState(name);
              if (!piState) {
                return textResult(
                  `⚠️ Started tmux session ${name}, but Pi RPC did not respond yet. Try /askpi resume again in a few seconds.`,
                );
              }

              record.inFlight = undefined;
              // Refresh stored Pi session pointers.
              if (piState.sessionId) record.pi.sessionId = piState.sessionId;
              if (piState.sessionFile) record.pi.sessionFile = piState.sessionFile;
              record.updatedAt = Date.now();
              await writeJsonAtomic(recordPath, record);

              return textResult(
                `✅ Restarted Pi RPC in ${name}. You can now use /askpi normally again.`,
                {
                  ok: true,
                  action: "resume",
                  tmux: name,
                  didRestart: true,
                  killedOldSession: existed,
                  piState,
                },
              );
            });
          }

          return jsonResult({ ok: false, error: `Unknown action: ${action}` });
        },
      };
    });
  },
};
