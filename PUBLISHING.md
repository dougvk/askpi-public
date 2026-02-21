# Publishing (Private-First)

## Preconditions

- Tests pass: `npm test`.
- `openclaw.plugin.json` is present and valid.
- `package.json` includes `openclaw.extensions`.

## Package

```bash
npm pack
```

Expected tarball: `dougvk-askpi-<version>.tgz`.

## Validate Install Without Touching Live Plugins

Use an isolated OpenClaw state dir:

```bash
STATE=/tmp/openclaw-plugin-install-state-askpi
CONFIG="$STATE/openclaw.json"
rm -rf "$STATE"
mkdir -p "$STATE"
OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$CONFIG" \
  openclaw plugins install ./dougvk-askpi-<version>.tgz
OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$CONFIG" \
  openclaw plugins list --json
```

## Configure Before Runtime Use

`askpi` installs without token, but runtime commands require it.

Set:

- `plugins.entries.askpi.config.token`

Then restart the gateway.

Load-time isolation guards also require:

- `OPENCLAW_STATE_DIR` (or `CLAWDBOT_STATE_DIR`) set to a dedicated state root.
- Dedicated askpi tmux socket env (recommended: `OPENCLAW_ASKPI_TMUX_SOCKET_PATH`).

## Recommended Dedicated askpi State Home

askpi state lives under each agent root (`<agentRoot>/askpi/...`). To isolate environments, use separate agent roots and separate tmux socket paths.

Example tmux socket isolation:

```bash
mkdir -p /srv/openclaw/state/askpi-prod/tmux
chmod 700 /srv/openclaw/state/askpi-prod/tmux
export OPENCLAW_ASKPI_TMUX_SOCKET_PATH=/srv/openclaw/state/askpi-prod/tmux/askpi.sock
```

If you also need isolated session metadata, set global `session.store` in OpenClaw config to a dedicated file for that environment.

## Optional Registry Publish

`package.json` sets `publishConfig.access=restricted`.

When ready:

```bash
npm publish
```
