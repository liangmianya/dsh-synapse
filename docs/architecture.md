# Architecture and runtime boundaries

## Purpose

`dsh-synapse` is a presentation and organization layer for DeepSeek Harness conversations. It turns existing DSH sessions, turns, and forks into a visual map without replacing the systems that own those conversations.

## Web profile integration

The package contributes `cordis.patch.yml`, which inserts the `dsh-synapse` service into the DSH `web` profile. It reuses the existing DSH Web server and client runtime.

The plugin:

- does not start a second HTTP server;
- does not create a second model or agent runtime;
- does not replace DSH authentication or permission checks;
- does not support non-Web profiles unless those profiles explicitly add the plugin.

## Conversation ownership

DSH session logs remain the source of truth for conversation content and lifecycle. Native DSH operations own:

- creating and opening sessions;
- sending follow-up messages;
- forking sessions;
- archiving sessions;
- model and tool execution;
- permission and approval decisions.

Synapse projects committed DSH events into cards and sends user actions back through the native DSH session bridge.

## Harness compatibility

This revision is built and verified against DeepSeek Harness `0.1.7-rc.2`. Both halves call Harness APIs directly, so a Harness release that changes them requires a matching plugin release.

Host half (`index.js`) calls:

- `ctx.webServer.register({ kind, path, handler })`, the route registry of `@deepseek-ai/dsh-host-webserver`;
- `ctx.sessions.list()`, the live `Session` objects of `@deepseek-ai/dsh-session`;
- the untagged (global) `session/created` and `session/event` listeners;
- `session.snapshotEvents()` for a projection replay, `session.inheritedEventCount` for the durable fork cut, and `session.header.cwd` for workspace grouping.

Client half (`client.js`), through `dsh.client.inject` in `package.json`:

- `sessions.list`, `sessions.binding`, `sessions.create`, `sessions.fork` from `@deepseek-ai/dsh-api-session-controller`, plus `sessions.retain`/`release` for two purposes: owning a reference across a prompt round-trip, and owning one for every *running* Session whose live reply the map mirrors, because no Harness release mints a Session scope implicitly any more and an unowned Session has no readable Chat view;
- `workspaces.list` from `@deepseek-ai/dsh-api-workspace-controller`;
- `uiWorkspace.openSession` from `@deepseek-ai/dsh-client-ui-workspace` for selecting a Session;
- `uiConversation.binding(sessionId).target('chat')` from `@deepseek-ai/dsh-client-ui-conversation` for the streaming reply and the turn anchor index, because the Client builds a view snapshot only after something subscribes to its target. A Session the browser does not observe still reports its `running` flag, which the list row carries.

Two Harness dependencies are worth re-checking on every upgrade:

- `snapshotEvents()` is marked deprecated: Harness is moving complete session logs out of memory. Rebuilding this canvas from history needs the full sequence, so the call remains, and it needs a storage-backed successor (an asynchronous paged read) before Harness removes it.
- The browser half must acquire its own `SessionReference` before sending a prompt; borrowing an Agent scope no longer opens one.

## Canvas metadata

By default, Synapse stores canvas metadata at:

```text
$DSH_HOME/synapse/workspaces.json
```

The file contains organizational state such as workspace mapping, card layout, and fork anchors. It does not replace session logs.

Consequences:

- deleting the file resets canvas organization but does not delete conversations;
- uninstalling the plugin keeps the file, so reinstalling restores the canvas;
- older schema versions migrate when loaded;
- two processes sharing the same file can still produce last-writer-wins replacement despite locking and external-change warnings.

Run one `dsh web` instance for each shared profile.

## Projection model

With `autoProjection` enabled, committed DSH session events are grouped by working directory and projected into the corresponding Synapse workspace.

Each user question becomes a conversation card. The following assistant messages are folded into that turn, and the final assistant reply is shown as the answer. Forked sessions connect to the parent turn at the durable DSH seed boundary rather than at an arbitrary canvas coordinate.

Projected card text is capped at 8000 characters. Longer messages receive a truncation marker in the card, while their complete content remains available from the conversation detail view.

Projection writes are coalesced during event bursts, and live updates reuse cached Markdown and patch the active card instead of rebuilding the complete canvas. Card coordinates remain visual metadata only and never determine conversation lineage.

## Tool process folding

Live events pair tool calls and results by `callId` and render them inside the related assistant reply instead of as standalone conversation cards.

Legacy v3 migrations did not always have durable call IDs. Those records pair each tool call with the next tool result by order during migration.

## Browser-local state

Some interaction state, such as dragged card positions and branch anchors, may be cached in browser local storage to keep the canvas responsive. Durable workspace metadata is still written through the Synapse service.

Private-browsing restrictions or local-storage failures must not prevent DSH conversations from operating; they only reduce persistence of visual preferences.

## Host validation

The `/synapse` endpoint always accepts `localhost` and `127.0.0.1`. Additional LAN or proxy authorities must be listed in `trustedHosts` as a host or `host:port` value.

This validation is part of the Web surface and does not replace broader network access controls.

## Model and KV-cache impact

Synapse reads session events only after DSH commits them. It does not add or modify:

- system prompts;
- user request content;
- model request headers;
- tool schemas or registries;
- provider routing;
- approval context.

As a result, the plugin has no direct model-experience effect and does not invalidate an otherwise reusable KV-cache prefix.

## Operational limitations

- Only the `web` profile is supported by the bundled patch.
- Canvas metadata and session content have different owners and backup requirements.
- A single shared metadata file is not a multi-writer database.
- Browser state can be cleared independently from DSH Home data.
- Historical migrations may have less precise tool-call pairing than live projection.

## Related documentation

- [Chinese user guide](zh-CN/README.md)
- [English user guide](en/README.md)
- [Development and release guide](development.md)
- [Project overview](../README.md)
