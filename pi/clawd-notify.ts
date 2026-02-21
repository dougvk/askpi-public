import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXT_ID = "clawd-notify";
const EXT_PENDING_ID = "clawd-notify-pending";
const EXT_ERROR_ID = "clawd-notify-error";

type PendingPayload = {
  sessionKey: string;
  eventId: string;
  /** Stable id for idempotent delivery. Backward-compatible alias of eventId. */
  completionId?: string;
  piSessionId: string;
  piSessionFile?: string;
  piSessionDir?: string;
  leafId?: string | null;
  tmuxSession?: string;
  askpiSessionId?: string;
  cwd?: string;
  ts: number;
};

type PendingTombstone = {
  eventId: string;
  clearedAt: number;
};

type NotifyErrorEntry = {
  eventId: string;
  ts: number;
  kind: "http" | "network" | "timeout" | "unknown";
  message: string;
  status?: number;
  url?: string;
};

let retryTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;
let consecutiveFailures = 0;
let lastErrorLogAt = 0;
let lastErrorEventId = "";

function getEnv(name: string): string {
  return typeof process.env[name] === "string" ? String(process.env[name]).trim() : "";
}

function getNotifyConfig(): { url: string; token: string; sessionKey: string } {
  const url = getEnv("CLAWD_NOTIFY_URL");
  const token = getEnv("CLAWD_NOTIFY_TOKEN");
  const sessionKey = getEnv("CLAWD_SESSION_KEY");
  return { url, token, sessionKey };
}

function safeUrlForLogs(raw: string): string {
  try {
    const u = new URL(raw);
    // Never log tokens. URL should only be localhost anyway.
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "";
  }
}

function loadLastSentEventId(ctx: any): string | null {
  try {
    const entries = ctx.sessionManager.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "custom" && e.customType === EXT_ID) {
        const id = e?.data?.lastEventId;
        if (typeof id === "string" && id.trim()) return id.trim();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function loadPendingQueue(ctx: any): PendingPayload[] {
  // Build a queue of pending payloads, excluding cleared tombstones.
  // This fixes the classic “tombstone makes us resend the older payload forever” bug.
  try {
    const entries = ctx.sessionManager.getEntries?.() ?? [];

    const cleared = new Set<string>();
    const byEventId = new Map<string, { payload: PendingPayload; idx: number }>();

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e?.type !== "custom" || e.customType !== EXT_PENDING_ID) continue;
      const d = e?.data;
      if (!d || typeof d !== "object") continue;

      // Tombstone
      if (typeof d.clearedAt === "number" && typeof d.eventId === "string" && d.eventId.trim()) {
        const id = d.eventId.trim();
        cleared.add(id);
        // If we saw a payload earlier for the same eventId, remove it.
        byEventId.delete(id);
        continue;
      }

      // Pending payload
      const sessionKey = typeof d.sessionKey === "string" ? d.sessionKey.trim() : "";
      const eventId = typeof d.eventId === "string" ? d.eventId.trim() : "";
      if (!sessionKey || !eventId) continue;
      if (cleared.has(eventId)) continue;

      // Keep the latest payload for an eventId (should usually be unique).
      byEventId.set(eventId, { payload: d as PendingPayload, idx: i });
    }

    const pending = Array.from(byEventId.values())
      .filter((x) => x?.payload && typeof x.payload.ts === "number")
      .sort((a, b) => (a.payload.ts - b.payload.ts) || (a.idx - b.idx))
      .map((x) => x.payload);

    return pending;
  } catch {
    return [];
  }
}

function appendCleared(pi: ExtensionAPI, eventId: string) {
  const tombstone: PendingTombstone = { eventId, clearedAt: Date.now() };
  pi.appendEntry(EXT_PENDING_ID, tombstone);
}

async function postNotify(url: string, token: string, payload: PendingPayload) {
  // Guard against hanging during gateway restarts / tailnet proxy transitions.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = (text || res.statusText || "").slice(0, 300);
    const err = new Error(`notify failed (${res.status}): ${snippet}`);
    (err as any).status = res.status;
    throw err;
  }
}

function classifyError(err: any): { kind: NotifyErrorEntry["kind"]; message: string; status?: number } {
  const msg = (err && typeof err.message === "string" ? err.message : String(err ?? ""))
    .trim()
    .slice(0, 500);

  // AbortController errors can vary by runtime.
  if (/(abort|aborted|timeout)/i.test(msg)) return { kind: "timeout", message: msg };

  const status = typeof err?.status === "number" ? err.status : undefined;
  if (typeof status === "number") return { kind: "http", message: msg, status };

  if (/(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket|fetch failed)/i.test(msg)) {
    return { kind: "network", message: msg };
  }

  return { kind: "unknown", message: msg };
}

function maybeLogError(pi: ExtensionAPI, eventId: string, url: string, err: any) {
  // Throttle error log entries to avoid blowing up the JSONL.
  const now = Date.now();
  if (lastErrorEventId === eventId && now - lastErrorLogAt < 30_000) return;

  lastErrorEventId = eventId;
  lastErrorLogAt = now;

  const c = classifyError(err);
  const entry: NotifyErrorEntry = {
    eventId,
    ts: now,
    kind: c.kind,
    message: c.message,
    ...(typeof c.status === "number" ? { status: c.status } : {}),
    ...(url ? { url: safeUrlForLogs(url) } : {}),
  };

  pi.appendEntry(EXT_ERROR_ID, entry);
}

function computeNextRetryDelayMs(): number {
  // Exponential backoff with jitter, capped.
  // 0.5s, 1s, 2s, 4s, 8s, 16s, 30s, 60s, 90s...
  const base = 500;
  const cap = 90_000;
  const exp = Math.min(8, Math.max(0, consecutiveFailures));
  const raw = Math.min(cap, base * Math.pow(2, exp));
  const jitter = Math.floor(raw * (0.2 * Math.random()));
  return Math.max(250, raw + jitter);
}

function scheduleRetry(pi: ExtensionAPI, ctx: any, why: string) {
  if (retryTimer) return;

  const delay = computeNextRetryDelayMs();
  // Keep a small breadcrumb in the session for debugging (no secrets).
  pi.appendEntry(EXT_ID, { retryScheduledAt: Date.now(), retryInMs: delay, why });

  retryTimer = setTimeout(() => {
    retryTimer = null;
    void enqueueFlush(pi, ctx, "retry-timer");
  }, delay);
}

async function flushPendingOnce(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  const pending = loadPendingQueue(ctx);
  if (!pending.length) {
    consecutiveFailures = 0;
    return true;
  }

  const { url, token } = getNotifyConfig();
  if (!url || !token) {
    // Config missing; do nothing (but keep pending).
    return false;
  }

  const lastSent = loadLastSentEventId(ctx);

  for (const p of pending) {
    if (!p || typeof p.eventId !== "string" || !p.eventId.trim()) continue;

    // If we already recorded this eventId as sent, clear any stale pending entry.
    if (lastSent && lastSent === p.eventId) {
      appendCleared(pi, p.eventId);
      continue;
    }

    try {
      await postNotify(url, token, p);

      // Mark as sent.
      pi.appendEntry(EXT_ID, { lastEventId: p.eventId, ts: Date.now() });
      // Clear pending by writing a tombstone.
      appendCleared(pi, p.eventId);

      consecutiveFailures = 0;
    } catch (err: any) {
      consecutiveFailures++;
      maybeLogError(pi, p.eventId, url, err);
      return false;
    }
  }

  return true;
}

function enqueueFlush(pi: ExtensionAPI, ctx: any, why: string): Promise<void> {
  if (flushInFlight) return flushInFlight;

  flushInFlight = (async () => {
    const ok = await flushPendingOnce(pi, ctx);
    if (!ok) scheduleRetry(pi, ctx, why);
  })().finally(() => {
    flushInFlight = null;
  });

  return flushInFlight;
}

export default function (pi: ExtensionAPI) {
  // Retry pending notifications after restart or when the agent wakes up.
  pi.on("session_start", async (_event, ctx) => {
    await enqueueFlush(pi, ctx, "session_start");
  });

  pi.on("agent_start", async (_event, ctx) => {
    await enqueueFlush(pi, ctx, "agent_start");
  });

  pi.on("agent_end", async (_event, ctx) => {
    const { url, token, sessionKey } = getNotifyConfig();
    if (!url || !token || !sessionKey) return;

    const piSessionId = ctx.sessionManager.getSessionId?.() ?? "";
    const leafId = ctx.sessionManager.getLeafId?.() ?? null;
    const piSessionFile = ctx.sessionManager.getSessionFile?.();
    const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;

    const eventId = `${piSessionId}:${String(leafId ?? "")}`;
    if (!piSessionId || !leafId) {
      // If we cannot build a stable eventId, don't notify.
      return;
    }

    // Avoid re-notifying the same leaf over and over.
    const last = loadLastSentEventId(ctx);
    if (last === eventId) return;

    const payload: PendingPayload = {
      sessionKey,
      eventId,
      completionId: eventId,
      piSessionId,
      leafId,
      piSessionFile: typeof piSessionFile === "string" ? piSessionFile : undefined,
      piSessionDir: getEnv("CLAWD_PI_SESSION_DIR") || undefined,
      tmuxSession: getEnv("CLAWD_TMUX_SESSION") || undefined,
      askpiSessionId: getEnv("CLAWD_ASKPI_SESSION_ID") || getEnv("CLAWD_CODING_SESSION_ID") || undefined,
      cwd: typeof cwd === "string" ? cwd : undefined,
      ts: Date.now(),
    };

    // Store pending first so we can recover if notify fails.
    pi.appendEntry(EXT_PENDING_ID, payload);

    // Try to flush immediately; if it fails, a background retry timer will keep trying.
    await enqueueFlush(pi, ctx, "agent_end");
  });
}
