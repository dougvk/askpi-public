import test from "node:test";
import assert from "node:assert/strict";

import { buildAskpiTmuxAttachCommand, resolveAskpiTmuxSocketConfig } from "../index.ts";

test("resolveAskpiTmuxSocketConfig prefers explicit socket path", () => {
  const cfg = resolveAskpiTmuxSocketConfig({
    OPENCLAW_ASKPI_TMUX_SOCKET_PATH: "/tmp/custom-askpi.sock",
    OPENCLAW_ASKPI_TMUX_SOCKET_NAME: "ignored-name",
  });
  assert.deepEqual(cfg.tmuxArgs, ["-S", "/tmp/custom-askpi.sock"]);
  assert.equal(cfg.socketPath, "/tmp/custom-askpi.sock");
  assert.equal(cfg.displayArgs, "-S '/tmp/custom-askpi.sock'");
});

test("resolveAskpiTmuxSocketConfig uses explicit socket name when path is absent", () => {
  const cfg = resolveAskpiTmuxSocketConfig({
    OPENCLAW_ASKPI_TMUX_SOCKET_NAME: "askpi-test",
  });
  assert.deepEqual(cfg.tmuxArgs, ["-L", "askpi-test"]);
  assert.equal(cfg.socketPath, undefined);
  assert.equal(cfg.displayArgs, "-L 'askpi-test'");
});

test("resolveAskpiTmuxSocketConfig falls back to OPENCLAW_TMUX_SOCKET_DIR", () => {
  const cfg = resolveAskpiTmuxSocketConfig({
    OPENCLAW_TMUX_SOCKET_DIR: "/tmp/my-openclaw-sockets",
  });
  assert.deepEqual(cfg.tmuxArgs, ["-S", "/tmp/my-openclaw-sockets/openclaw-askpi.sock"]);
  assert.equal(cfg.socketPath, "/tmp/my-openclaw-sockets/openclaw-askpi.sock");
  assert.equal(cfg.displayArgs, "-S '/tmp/my-openclaw-sockets/openclaw-askpi.sock'");
});

test("resolveAskpiTmuxSocketConfig falls back to CLAWDBOT_TMUX_SOCKET_DIR", () => {
  const cfg = resolveAskpiTmuxSocketConfig({
    CLAWDBOT_TMUX_SOCKET_DIR: "/tmp/my-clawdbot-sockets",
  });
  assert.deepEqual(cfg.tmuxArgs, ["-S", "/tmp/my-clawdbot-sockets/openclaw-askpi.sock"]);
  assert.equal(cfg.socketPath, "/tmp/my-clawdbot-sockets/openclaw-askpi.sock");
  assert.equal(cfg.displayArgs, "-S '/tmp/my-clawdbot-sockets/openclaw-askpi.sock'");
});

test("resolveAskpiTmuxSocketConfig falls back to TMPDIR then /tmp", () => {
  const cfgTmpdir = resolveAskpiTmuxSocketConfig({
    TMPDIR: "/run/user/1000",
  });
  assert.deepEqual(cfgTmpdir.tmuxArgs, ["-S", "/run/user/1000/openclaw-tmux-sockets/openclaw-askpi.sock"]);
  assert.equal(cfgTmpdir.socketPath, "/run/user/1000/openclaw-tmux-sockets/openclaw-askpi.sock");

  const cfgDefault = resolveAskpiTmuxSocketConfig({});
  assert.deepEqual(cfgDefault.tmuxArgs, ["-S", "/tmp/openclaw-tmux-sockets/openclaw-askpi.sock"]);
  assert.equal(cfgDefault.socketPath, "/tmp/openclaw-tmux-sockets/openclaw-askpi.sock");
});

test("buildAskpiTmuxAttachCommand uses resolved socket arguments", () => {
  assert.equal(
    buildAskpiTmuxAttachCommand("clawd-pi-abc123", {
      OPENCLAW_ASKPI_TMUX_SOCKET_PATH: "/tmp/custom.sock",
    }),
    "tmux -S '/tmp/custom.sock' attach -t clawd-pi-abc123",
  );
  assert.equal(
    buildAskpiTmuxAttachCommand("clawd-pi-def456", {
      OPENCLAW_ASKPI_TMUX_SOCKET_NAME: "askpi-socket",
    }),
    "tmux -L 'askpi-socket' attach -t clawd-pi-def456",
  );
});
