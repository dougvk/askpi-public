import test from "node:test";
import assert from "node:assert/strict";

import { parseAskpiRawCommand } from "../index.ts";

test("parseAskpiRawCommand maps canonical commands", () => {
  assert.deepEqual(parseAskpiRawCommand(""), { action: "help" });
  assert.deepEqual(parseAskpiRawCommand("help"), { action: "help" });
  assert.deepEqual(parseAskpiRawCommand("status"), { action: "status" });
  assert.deepEqual(parseAskpiRawCommand("new"), { action: "new" });
  assert.deepEqual(parseAskpiRawCommand("new /home/dvk"), { action: "new", cwd: "/home/dvk" });
  assert.deepEqual(parseAskpiRawCommand("stop"), { action: "stop" });
  assert.deepEqual(parseAskpiRawCommand("reset"), { action: "reset" });
  assert.deepEqual(parseAskpiRawCommand("handoff"), { action: "handoff" });
  assert.deepEqual(parseAskpiRawCommand("resume"), { action: "resume" });
});

test("parseAskpiRawCommand rejects removed command names", () => {
  const removed = ["ensure", "inspect", "diagnose", "peek", "gc", "prune", "restore-all"];
  for (const cmd of removed) {
    const parsed = parseAskpiRawCommand(cmd);
    assert.equal("error" in parsed, true);
  }
});

test("parseAskpiRawCommand defaults to send for free-form prompts", () => {
  assert.deepEqual(parseAskpiRawCommand("fix this file"), { action: "send", message: "fix this file" });
  // Non-absolute `new ...` is treated as prompt text so normal language still works.
  assert.deepEqual(parseAskpiRawCommand("new feature request"), {
    action: "send",
    message: "new feature request",
  });
});
