import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  computeCompletionId,
  normalizeDeliveryHint,
  normalizeDeliveryHintForSessionKey,
  inferTelegramDeliveryFromSessionKey,
  resolveSessionStorePath,
  shellQuote,
  applyDeliveryResolvers,
} from "../lib.js";

test("computeCompletionId prefers completionId then eventId", () => {
  assert.equal(computeCompletionId({ completionId: " abc " }), "abc");
  assert.equal(computeCompletionId({ eventId: " e " }), "e");
  assert.equal(computeCompletionId({}), null);
});

test("normalizeDeliveryHint converts telegram slash:<id> to telegram:<id>", () => {
  const out = normalizeDeliveryHint({ channel: "telegram", to: "slash:535628820" });
  assert.deepEqual(out, { channel: "telegram", to: "telegram:535628820" });
});

test("normalizeDeliveryHint drops discord slash:<id>", () => {
  const out = normalizeDeliveryHint({ channel: "discord", to: "slash:509282260885700608" });
  assert.deepEqual(out, { channel: "discord" });
});

test("normalizeDeliveryHintForSessionKey infers discord channel target from sessionKey", () => {
  const out = normalizeDeliveryHintForSessionKey(
    { channel: "discord", to: "slash:509282260885700608" },
    "agent:main:discord:channel:1462152539658260563",
  );
  assert.deepEqual(out, { channel: "discord", to: "channel:1462152539658260563" });
});

test("inferTelegramDeliveryFromSessionKey parses telegram group topic", () => {
  const out = inferTelegramDeliveryFromSessionKey(
    "agent:main:telegram:group:-1001234567890:topic:99",
  );
  assert.deepEqual(out, {
    channel: "telegram",
    to: "telegram:-1001234567890",
    threadId: 99,
    messageThreadId: 99,
  });
});

test("normalizeDeliveryHintForSessionKey adds messageThreadId for telegram topic sessionKey", () => {
  const out = normalizeDeliveryHintForSessionKey(
    { channel: "telegram", to: "telegram:-1001234567890" },
    "agent:main:telegram:group:-1001234567890:topic:99",
  );
  assert.deepEqual(out, {
    channel: "telegram",
    to: "telegram:-1001234567890",
    threadId: 99,
    messageThreadId: 99,
  });
});

test("applyDeliveryResolvers maps sessionKey to delivery hint", () => {
  const out = applyDeliveryResolvers(
    "agent:main:slack:channel:C1:thread:111.222",
    [
      {
        channel: "slack",
        pattern: "^agent:[^:]+:slack:channel:([^:]+)(?::thread:([^:]+))?$",
        toTemplate: "channel:$1",
        threadIdTemplate: "$2",
      },
    ],
  );
  assert.deepEqual(out, {
    channel: "slack",
    to: "channel:C1",
    threadId: "111.222",
  });
});

test("applyDeliveryResolvers skips invalid resolver entries", () => {
  const out = applyDeliveryResolvers("agent:main:discord:channel:123", [
    null,
    { channel: "discord", pattern: "(", toTemplate: "channel:$1" },
  ]);
  assert.equal(out, null);
});

test("applyDeliveryResolvers ignores bad regex but still matches later resolver", () => {
  const out = applyDeliveryResolvers("agent:main:discord:channel:123", [
    { channel: "discord", pattern: "(", toTemplate: "channel:$1" },
    { channel: "discord", pattern: "^agent:[^:]+:discord:channel:(\\d+)$", toTemplate: "channel:$1" },
  ]);
  assert.deepEqual(out, { channel: "discord", to: "channel:123" });
});

test("shellQuote produces a single safe shell token", () => {
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("hello"), "'hello'");
  assert.equal(shellQuote("hello world"), "'hello world'");
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});

test("resolveSessionStorePath falls back to agent sessions.json", () => {
  assert.equal(
    resolveSessionStorePath({ agentRootDir: "/tmp/agent-root", agentId: "main" }),
    "/tmp/agent-root/sessions/sessions.json",
  );
});

test("resolveSessionStorePath resolves {agentId} and ~", () => {
  const home = os.homedir();
  const out = resolveSessionStorePath({
    agentRootDir: "/tmp/agent-root",
    agentId: "main",
    storeOverride: "~/stores/{agentId}/sessions.json",
  });
  assert.equal(out, path.resolve(home, "stores/main/sessions.json"));
});
