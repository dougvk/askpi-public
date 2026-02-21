# @dougvk/askpi

OpenClaw plugin that runs one Pi coding runtime per chat session, backed by dedicated tmux sessions and callback delivery.

## Commands

- `/askpi help`
- `/askpi status`
- `/askpi new [abs path]`
- `/askpi <prompt>`
- `/askpi stop`
- `/askpi reset`
- `/askpi handoff`
- `/askpi resume`

## Command Behavior

- `/askpi help`: shows command usage for this plugin.
- `/askpi status`: returns a single status mode tailored to askpi RPC/tmux session state.
- `/askpi new [abs path]`: archives prior session state and starts a fresh session id.
- `/askpi <prompt>`: sends a prompt to Pi; if Pi is already streaming, the message is queued as a follow-up.
- `/askpi stop`: stops the active tmux session for this chat and clears in-flight runtime state.
- `/askpi reset`: keeps the current session id and restarts runtime state.
- `/askpi handoff`: switches the chat session into interactive Pi TUI handoff and returns attach/resume instructions.
- `/askpi resume`: restarts Pi RPC automation for the same chat session after handoff/manual use.

## Requirements

- `tmux` available on PATH.
- OpenClaw gateway with this plugin enabled.
- `OPENCLAW_STATE_DIR` (or `CLAWDBOT_STATE_DIR`) must be explicitly set to a dedicated state root.
- Dedicated askpi tmux socket env must be set (`OPENCLAW_ASKPI_TMUX_SOCKET_PATH` recommended).
  - Plugin load fails with a helpful error if isolation env is missing.

## Install

### Local tarball (recommended while private)

```bash
npm pack
openclaw plugins install ./dougvk-askpi-<version>.tgz
```

### npm spec (private package)

```bash
openclaw plugins install @dougvk/askpi@<version>
```

## Config

Plugin manifest config schema is in `openclaw.plugin.json`.

Required:

- `token`: shared secret used by `/askpi/notify` for runtime command flows.

Install note:

- Plugin installation can succeed without `token`, but `new/send/reset/resume` will return `missing_token` until configured.

Optional highlights:

- `tmuxPrefix`
- `httpPath`
- `deliveryResolvers`

## State Layout And Isolation

askpi stores session state under the agent root directory:

- `<agentRoot>/askpi/<session-hash>.json`
- `<agentRoot>/askpi/<session-hash>/pi-session/`
- `<agentRoot>/askpi/archive/*.json`

Compatibility note:

- If `<agentRoot>/coding-sessions` exists, askpi will use/migrate that legacy layout.

askpi does not currently expose a plugin config key to move these paths directly; isolate by choosing a dedicated agent root and tmux socket.

Recommended setup:

```json
{
  "plugins": {
    "entries": {
      "askpi": {
        "enabled": true,
        "config": {
          "token": "<set-a-real-token>",
          "tmuxPrefix": "clawd-pi-prod"
        }
      }
    }
  }
}
```

Set a dedicated tmux socket (example):

```bash
export OPENCLAW_ASKPI_TMUX_SOCKET_PATH=/srv/openclaw/state/askpi-prod/tmux/askpi.sock
```

Best practices:

- Keep a unique agent root per environment for askpi state isolation.
- Keep askpi tmux socket separate from default tmux sockets.
- Use restrictive permissions on state/sockets.
- Configure `session.store` globally if you want session-delivery metadata in a dedicated path.

## Tests

```bash
npm test
```
