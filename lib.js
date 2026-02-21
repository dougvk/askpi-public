// Shared helpers for the askpi out-of-tree plugin.
// Keep this file plain JS so it can be imported by Node tests without TS loaders.

import os from "node:os";
import path from "node:path";

export function shellQuote(value) {
  const s = String(value ?? "");
  // POSIX-ish safe quoting for /bin/sh.
  // Produces a single shell token that expands to the original string.
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export function resolveSessionStorePath({ agentRootDir, agentId, storeOverride }) {
  const fallback = path.join(agentRootDir, "sessions", "sessions.json");
  const raw = typeof storeOverride === "string" ? storeOverride.trim() : "";
  if (!raw) return fallback;

  let expanded = raw;
  if (agentId && expanded.includes("{agentId}")) {
    expanded = expanded.replaceAll("{agentId}", agentId);
  }

  if (expanded.startsWith("~")) {
    expanded = expanded.replace(/^~(?=$|[\\/])/, os.homedir());
  }

  return path.resolve(expanded);
}

export function normalizeDeliveryHint(value) {
  if (!value) return null;
  const channel = typeof value.channel === "string" ? value.channel.trim() : "";
  const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
  let to = typeof value.to === "string" ? value.to.trim() : "";

  const threadIdRaw = value.threadId;
  const messageThreadIdRaw = value.messageThreadId;
  const isForumRaw = value.isForum;

  // Keep thread ids as string|number; normalize empty strings to undefined.
  const normalizeThreadId = (raw) => {
    if (raw == null) return undefined;
    if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : undefined;
    if (typeof raw === "string") {
      const t = raw.trim();
      return t ? t : undefined;
    }
    return undefined;
  };

  const threadId = normalizeThreadId(threadIdRaw);
  const messageThreadId = normalizeThreadId(messageThreadIdRaw);
  const isForum = typeof isForumRaw === "boolean" ? isForumRaw : undefined;

  // Telegram has no separate slash-command "target". A `slash:<id>` value can leak into
  // session routing fields (e.g. from native command handling). It is not a valid outbound
  // telegram target.
  if (channel === "telegram" && to) {
    const m = /^slash:(\d+)$/.exec(to);
    if (m?.[1]) to = `telegram:${m[1]}`;
  }

  // Discord: a `slash:<id>` value refers to an interaction target, not a deliverable
  // outbound recipient.
  if (channel === "discord" && /^slash:\d+$/.test(to)) {
    to = "";
  }

  if (!channel && !to && !accountId && threadId == null && messageThreadId == null && isForum == null) {
    return null;
  }

  const out = {};
  if (channel) out.channel = channel;
  if (to) out.to = to;
  if (accountId) out.accountId = accountId;
  if (threadId !== undefined) out.threadId = threadId;
  if (messageThreadId !== undefined) out.messageThreadId = messageThreadId;
  if (isForum !== undefined) out.isForum = isForum;
  return out;
}

export function inferDiscordToFromSessionKey(sessionKey) {
  // Common form: agent:<agentId>:discord:channel:<channelId>
  const m = /:discord:channel:(\d+)$/.exec(sessionKey);
  if (m?.[1]) return `channel:${m[1]}`;
  return null;
}

export function inferTelegramDeliveryFromSessionKey(sessionKey) {
  // Common form for telegram groups: agent:<agentId>:telegram:group:<chatId>
  // For topics: agent:<agentId>:telegram:group:<chatId>:topic:<topicId>
  const m = /:telegram:group:([^:]+)(?::topic:(\d+))?$/.exec(sessionKey);
  if (!m?.[1]) return null;
  const chatId = m[1];
  const topicId = m[2] ? Number.parseInt(m[2], 10) : undefined;
  if (topicId != null && Number.isFinite(topicId)) {
    return {
      channel: "telegram",
      to: `telegram:${chatId}`,
      threadId: topicId,
      messageThreadId: topicId,
    };
  }
  return {
    channel: "telegram",
    to: `telegram:${chatId}`,
  };
}

export function inferDeliveryHintFromSessionKey(sessionKey) {
  const discordTo = inferDiscordToFromSessionKey(sessionKey);
  if (discordTo) {
    return { channel: "discord", to: discordTo };
  }
  const telegram = inferTelegramDeliveryFromSessionKey(sessionKey);
  if (telegram) return telegram;
  return null;
}

export function normalizeDeliveryHintForSessionKey(value, sessionKey) {
  const normalized = normalizeDeliveryHint(value);
  if (!normalized) return null;

  if (normalized.channel === "discord") {
    if (!normalized.to || /^slash:\d+$/.test(normalized.to)) {
      const inferred = inferDiscordToFromSessionKey(sessionKey);
      if (inferred) {
        return {
          ...normalized,
          channel: "discord",
          to: inferred,
        };
      }
    }
  }

  if (normalized.channel === "telegram") {
    // If we have no usable `to`, infer from sessionKey.
    if (!normalized.to || /^slash:\d+$/.test(normalized.to)) {
      const inferred = inferTelegramDeliveryFromSessionKey(sessionKey);
      if (inferred) {
        return {
          ...normalized,
          ...inferred,
          accountId: normalized.accountId,
        };
      }
    }

    // If sessionKey includes a topic id, persist it explicitly.
    const inferred = inferTelegramDeliveryFromSessionKey(sessionKey);
    if (inferred?.messageThreadId != null) {
      return {
        ...normalized,
        messageThreadId: inferred.messageThreadId,
        threadId: inferred.threadId ?? inferred.messageThreadId,
      };
    }
  }

  return normalized;
}

function renderTemplate(template, match) {
  if (!template) return "";
  return template.replace(/\$(\d+)/g, (_, idx) => match[Number(idx)] ?? "");
}

function normalizeTemplateValue(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTemplateThreadId(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return undefined;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return trimmed;
}

export function applyDeliveryResolvers(sessionKey, resolvers) {
  if (!Array.isArray(resolvers) || resolvers.length === 0) return null;
  const key = String(sessionKey ?? "");
  if (!key) return null;

  for (const resolver of resolvers) {
    if (!resolver || typeof resolver !== "object") continue;
    const channel =
      typeof resolver.channel === "string" ? resolver.channel.trim().toLowerCase() : "";
    const pattern = typeof resolver.pattern === "string" ? resolver.pattern : "";
    const toTemplate = typeof resolver.toTemplate === "string" ? resolver.toTemplate : "";
    if (!channel || !pattern || !toTemplate) continue;

    const compiled = resolver.compiled instanceof RegExp ? resolver.compiled : null;
    let re = compiled;
    if (!re) {
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
    }

    const match = re.exec(key);
    if (!match) continue;

    const to = normalizeTemplateValue(renderTemplate(toTemplate, match));
    if (!to) continue;

    const threadId = normalizeTemplateThreadId(
      renderTemplate(resolver.threadIdTemplate, match),
    );
    const messageThreadId = normalizeTemplateThreadId(
      renderTemplate(resolver.messageThreadIdTemplate, match),
    );
    const accountId = normalizeTemplateValue(
      renderTemplate(resolver.accountIdTemplate, match),
    );

    const hint = normalizeDeliveryHint({
      channel,
      to,
      accountId,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    });
    if (hint) return hint;
  }

  return null;
}

export function computeCompletionId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const completionId = typeof payload.completionId === "string" ? payload.completionId.trim() : "";
  if (completionId) return completionId;
  const eventId = typeof payload.eventId === "string" ? payload.eventId.trim() : "";
  if (eventId) return eventId;
  return null;
}
