# dsh-synapse English Guide

`dsh-synapse` is a Web plugin for DeepSeek Harness (DSH). It adds a session map to the native conversation interface and organizes sessions, follow-ups, and forks from the same workspace as a browsable, draggable, and zoomable canvas.

The plugin does not replace DSH models, tools, sessions, permissions, or the Web server. DSH remains responsible for every conversation operation.

## Prerequisites

- A DeepSeek Harness release with the `dsh plugin` profile mechanism (2026-08 or later).
- Node.js `>= 22.19.0`.
- The `web` profile; other profiles are not currently supported.

## Installation

### Install from GitHub

```powershell
corepack pnpm dsh plugin --profile web add github:liangmianya/dsh-synapse
```

GitHub installs run the package `prepare` script, which validates JavaScript syntax with `node --check`.

### pnpm 10+ allowBuilds

pnpm 10 and later may block build scripts for Git dependencies by default. If installation is blocked, copy the **complete key printed by pnpm** into the DSH Web profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "dsh-synapse@https://codeload.github.com/liangmianya/dsh-synapse/tar.gz/<commit>": true
```

Use the complete key containing the tarball URL and commit, not the bare package name `dsh-synapse`. The key changes when the upstream commit changes, so use the newly printed value when upgrading.

### Install a local checkout

```powershell
corepack pnpm dsh plugin --profile web add link:E:\path\to\dsh-synapse
```

The `link:` form references the local checkout directly and is recommended for development. In a normal run, restart `dsh web` and refresh the page after editing the plugin.

## Start DSH Web

```powershell
corepack pnpm dsh web
```

Default address:

```text
http://127.0.0.1:3080/
```

Let DSH choose a free port when 3080 is occupied:

```powershell
corepack pnpm dsh web --port 0
```

Open the top **Session Map** switch after startup. Do not run two `dsh web` processes that share the same profile.

## Usage

1. Select a working directory in DSH or open an existing session.
2. Send at least one message so the session enters workspace history.
3. Open **Session Map** from the top switch.
4. Click a card or sidebar session to synchronize the current session between the map and native chat.
5. Use **Branch** on a completed answer to preserve an alternative path.
6. Open **Details** from a card to inspect the complete conversation.
7. Use **Open in DSH** or the top **Dialogue** switch to return to native chat.

The canvas supports:

- Panning and zooming up to 4×.
- Dragging cards with persisted positions.
- One-click focus on the current session.
- Smooth card scrolling and Markdown table rendering.
- Folding tool calls and results into the related assistant answer by `callId`.

## Configuration

The plugin is inserted through the profile's `cordis.patch.yml`. Override it in your own patch by targeting the row id `synapse`.

> A DSH patch replaces the row's complete `config`, so restate every value that must remain active.

| Key | Default | Description |
|---|---|---|
| `dataFile` | `$DSH_HOME/synapse/workspaces.json` | Canvas metadata persistence file |
| `autoProjection` | `true` | Automatically project committed DSH session events into cards |
| `projectionWorkspaceTitle` | `DSH 任务` | Title of the automatically projected workspace |
| `trustedHosts` | `[]` | Extra host or `host:port` values accepted by the `/synapse` Host check; `localhost` and `127.0.0.1` are always accepted |

Example:

```yaml
- id: synapse
  config:
    dataFile: !!js dshHomePath('synapse/my-workspaces.json')
    autoProjection: true
    projectionWorkspaceTitle: My tasks
    trustedHosts: []
```

Add the actual host to `trustedHosts` when exposing DSH on a LAN.

## Uninstall and data cleanup

Remove the plugin:

```powershell
corepack pnpm dsh plugin --profile web remove dsh-synapse
```

`remove` deletes the dependency and profile activation layer but keeps canvas data. Reinstalling reuses and migrates the old data when necessary.

For a complete cleanup, manually remove:

```text
$DSH_HOME/synapse/
```

A leftover `allowBuilds` key in `pnpm-workspace.yaml` is harmless and may also be removed.

## Data and runtime boundaries

- DSH session logs own the actual conversation content.
- Synapse `workspaces.json` stores only canvas metadata, layout, and branch anchors.
- Deleting `workspaces.json` loses canvas layout, never DSH sessions.
- The plugin starts no second Web server and creates no second agent system.
- It reads committed session events only and does not change model requests, system prompts, tool schemas, or reusable KV-cache prefixes.

See [Architecture and runtime boundaries](../architecture.md) for details.

## Known limitations

- Only the `web` profile is supported.
- Two DSH Web instances sharing one profile write the same `workspaces.json`. A cross-process write lock and external-modification warnings exist, but last-writer-wins replacement remains possible; run one instance.
- During v3 migration, legacy tool cards pair each call with the next result by order. Live events pair by `callId`.

## Development and releases

Contributor commands, GitHub Actions, and npm publishing are documented in the [Development and release guide](../development.md).

Return to the [project overview](../../README.md).
