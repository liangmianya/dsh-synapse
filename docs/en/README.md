# dsh-synapse English Guide

`dsh-synapse` is a Web plugin for DeepSeek Harness (DSH). It adds a session map to the native conversation interface and organizes sessions, follow-ups, and forks from the same workspace as a browsable, draggable, and zoomable canvas.

The plugin does not replace DSH models, tools, sessions, permissions, or the Web server. DSH remains responsible for every conversation operation.

## Prerequisites

- DeepSeek Harness `>= 0.1.7-rc.2`; this revision targets that release's Host session and Client service interfaces.
- Node.js `>= 22.19.0`.
- The right profile: the desktop app uses `desktop`, the `dsh web` command uses `web` (see below).

## Which profile to install into

DSH installs plugins per profile. Each profile keeps its own plugin list and `node_modules`, so the desktop app and the command line do not affect each other.

| How you run DSH | Profile to use |
|---|---|
| Desktop app (DeepSeek Harness client) | `desktop` |
| `dsh web` on the command line (if you keep that profile) | `web` |

- Installing from the app's plugin page already targets the profile the app uses, so you do not pick one there.
- **Quick self-check: if the "会话地图 / Session map" switch never appears, the plugin went into the other profile** — install again with the other `--profile`.
- A desktop install takes effect after **restarting the app**; a command-line install takes effect after restarting `dsh web` and refreshing the page.

## Installation

`dsh` is the launcher that ships with the DSH runtime, at `resources\runtime\cli\bin\dsh.cmd` inside the app directory. Check that it responds first:

```powershell
dsh --version
```

### Install from npm

```powershell
# Desktop app
dsh plugin --profile desktop add dsh-synapse

# Command line (only if you keep a web profile)
dsh plugin --profile web add dsh-synapse
```

The npm package ships prebuilt code, so no build-script permission is needed — the simplest install. GitHub and local-checkout routes below are alternatives.

### Install from GitHub

```powershell
dsh plugin --profile desktop add github:liangmianya/dsh-synapse
```

GitHub installs run the package `prepare` script, which validates JavaScript syntax with `node --check`.

### pnpm 10+ allowBuilds

pnpm 10 and later may block build scripts for Git dependencies by default. If installation is blocked, copy the **complete key printed by pnpm** into the matching profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "dsh-synapse@https://codeload.github.com/liangmianya/dsh-synapse/tar.gz/<commit>": true
```

Use the complete key containing the tarball URL and commit, not the bare package name `dsh-synapse`. The key changes when the upstream commit changes, so use the newly printed value when upgrading.

### Install a local checkout

```powershell
dsh plugin --profile desktop add link:E:\path\to\dsh-synapse
```

The `link:` form references the local checkout directly and is recommended for development. In a normal run, restart the host (the desktop app or `dsh web`) and refresh the page after editing the plugin.

## Start DSH Web

```powershell
dsh web
```

Default address:

```text
http://127.0.0.1:3080/
```

Let DSH choose a free port when 3080 is occupied:

```powershell
dsh web --port 0
```

Open the top **Session Map** switch after startup. Do not run two `dsh web` processes that share the same profile.

## Usage

1. Select a working directory in DSH or open an existing session.
2. Send at least one message so the session enters workspace history.
3. Open **Session Map** from the top switch.
4. Click a card or sidebar session to synchronize the current session between the map and native chat.
5. Use **Branch** on a completed answer to preserve an alternative path.
6. Click a card to open the reading panel; double-click its title to open the complete conversation.
7. Use **Open in DSH** or the top **Dialogue** switch to return to native chat.

The canvas supports:

- Panning and zooming up to 4×.
- Dragging cards with persisted positions.
- Expanding or collapsing descendant conversation subtrees.
- Showing only the selected session and its derived branches while keeping the current camera and zoom.
- One-click centering on the current session.
- Smooth card scrolling and Markdown table rendering.
- Folding tool calls and results into the related assistant answer by `callId`.

### Session focus and subtree folding

The map starts in **全工作区 (Entire workspace)** mode. Select a session in the sidebar and click **聚焦会话 (Focus session)** to show every turn of that session and its recursively derived branches. The sidebar still lists all sessions. Selecting another sidebar session changes the focus root; selecting a child session includes that child and its descendants, excluding its parent and siblings.

Clicking a branch card activates its DSH session and opens its details while keeping the existing focus scope. Switching between Entire workspace and Focus session only changes card and connector visibility. It keeps the current camera, zoom and card coordinates, including any pan or zoom changes made while focused. Use **定位 (Locate)** separately when you want to center the current session.

A card's **−** button hides every descendant, including children that are already folded, while keeping the card itself visible. Its **+** button expands the subtree again, preserving each child's own fold state and manually dragged position.

The **Dialogue / Session Map** switch can be moved too:

- Drag it by the six-dot grip on its left edge; the position is remembered per browser.
- Double-click the grip to return it to its shipped seat (centred under the window chrome).
- With the grip focused, the arrow keys nudge it by 8px.
- It always keeps an 8px grab margin from the viewport edges, so shrinking the window cannot strand it off screen.

### Canvas tools and shortcuts

The top toolbar contains the display scope and a **···** menu for automatic card layout and shortcut help. The arrow and hand tools are at the bottom left. Locate and zoom controls are at the bottom right; click the percentage to reset to 100%, fit the current scope, or fit the selected card.

The wheel pans by default; Shift + wheel pans horizontally, and Ctrl (⌘ on Mac) + wheel zooms. Card text keeps native scrolling and text selection. Drag a title or handle to move a card; use Space + left drag or middle drag to pan the map.

| Shortcut | Action |
|---|---|
| V / H | Select and read / pan |
| + / − / 0 | Zoom / reset to 100% |
| Shift + 1 / Shift + 2 | Fit current scope / selected card |
| F / ? | Locate / shortcut help |
| Esc | Cancel a gesture or animation, close menus or dialogs, blur an editor, then close the reading panel |
| Ctrl / ⌘ + Enter | Send; Enter inserts a newline by default |

Settings at the bottom of the sidebar provide wheel behavior, zoom speed, send shortcuts, reading size, themes, and editable follow-up phrases. Preferences are saved locally. Themes include follow DSH, light, dark, pastel green, pink, and blue.

## Recent changes

**0.5.10 · 2026-11-23**

- Removed the outline around the canvas when it receives focus.
- Extended the reading panel to the canvas bottom. Opening it moves locate and zoom controls to its left; closing it restores their bottom-right position.
- Adapted the narrow reading panel to the actual canvas width, preventing overlapping controls while preserving the camera, zoom, and card positions.

**0.5.9 · 2026-11-23**

- Reorganized canvas controls and added action and zoom menus with consistent theme styling.
- Updated pointer and keyboard interactions, wheel and send preferences, fit commands, and shortcut help.
- Added settings, reading sizes, three pastel themes, and editable follow-up phrases.
- Rechecked historical system-injected prompt cards against original session logs while retaining real messages; streaming decompression supports larger inherited fork histories.
- Coalesced smooth zoom preserves the pointer anchor; canceled drags restore positions, and closed menus release listeners.

**0.5.8 · 2026-11-22**

- Added session focus with all turns and recursively derived branches, while keeping the entire workspace's session list in the sidebar.
- Switching the display scope only changes visibility and preserves the current camera, zoom and card positions.
- Fixed nested folding: folded children no longer remain visible when their parent is collapsed, and their own fold state is retained when the parent expands.

**0.5.6**

- The top switch is draggable, remembers where you left it, and resets on a double-click (new).
- Interaction and rendering consistency: switching a conversation now brings it into view; folding a card no longer moves the canvas; a text selection in an answer no longer freezes the sidebar and the details panel; the fold/branch buttons on a card's right edge are no longer covered by the neighbouring card.
- Workspace switching no longer races the background poll, and the canvas is rebuilt only when data actually changes instead of several times a second.
- An unreadable `workspaces.json` now fails loudly and read-only instead of restoring an old backup over it (the 0.5.5 fallback was reverted).

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
dsh plugin --profile web remove dsh-synapse
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
- Projected message text is capped at 8000 characters; longer card text ends with “—…（详情查看全文）”, while the full content remains available in conversation details.
- The plugin starts no second Web server and creates no second agent system.

See [Architecture and runtime boundaries](../architecture.md) for details.

## Model Experience

None, as dsh-synapse only reads committed session events and renders them; it adds no system-prompt prose, tool schemas, or request-context content to any model request.

### KV Cache effect

Does not invalidate. The plugin never changes request headers, system prompts, or tool registries, so an already-reusable KV prefix stays reusable; canvas projection consumes session logs only after they are committed.

## Known limitations

- Both the `desktop` (desktop app) and `web` (`dsh web`) profiles are supported; any other profile has to add the package to its own bundle list. Installing into the wrong profile does not error — the Session map switch simply never appears.
- Two DSH Web instances sharing one profile write the same `workspaces.json`. A cross-process write lock and external-modification warnings exist, but last-writer-wins replacement remains possible; run one instance.
- During v3 migration, legacy tool cards pair each call with the next result by order. Live events pair by `callId`.

## Development and releases

Contributor commands, GitHub Actions, and npm publishing are documented in the [Development and release guide](../development.md).

Return to the [project overview](../../README.md).
