# Architecture and runtime boundaries

## Purpose

`dsh-synapse` is a presentation and organization layer for DeepSeek Harness conversations. It turns existing DSH sessions, turns, and forks into a visual map without replacing the systems that own those conversations.

## Profile integration

The package contributes `cordis.patch.yml`, which inserts the `dsh-synapse` service into whichever DSH profile lists the package as a bundle — `desktop` for the desktop app, `web` for the `dsh web` command. It reuses the existing DSH Web server and client runtime.

The plugin:

- does not start a second HTTP server;
- does not create a second model or agent runtime;
- does not replace DSH authentication or permission checks;
- stays inert in a profile that does not list it, so installing it into the wrong profile only means the map never appears (see the installation table in the user guide).

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

Only a turn a person typed becomes a card. The harness also writes its own `user/message` rows — the runtime-context snapshot, the skill catalogue `<system-reminder>` — and those carry a structured `data.source.kind`; injected kinds (`skill-catalog`, plus the runtime snapshot's text marker) are not projected, so they neither occupy a card nor steal the answer from the real question. Existing projections are pruned the same way when the store loads.

Projected messages keep only a preview (280 characters), not the body. The body already lives in the DSH session log, and a workspace file full of copies is what made one workspace reach several megabytes and stall the canvas (issue #42). The canvas asks the Host for the bodies of the cards it actually mounts (`GET /synapse/api/threads/:id/full`). The detail view renders at most 40 messages, initially on the latest page; opening a card selects the page containing its source sequence.

`session-bodies.js` enforces body and log budgets (issue #54). The body API accepts up to 40 integer `seqs`, a non-negative `cursor`, and `limit=1..20` (default 20). With no selectors it pages the stored thread order; with selectors the cursor indexes matching messages in that order. Responses include `cursor`, `nextCursor` (null at completion), and `total`. The client requests batches of 20 and follows the response cursor, which can advance by fewer than 20 when the response budget is reached. Successful partial pages never mark an entire thread loaded.

Actual serialized UTF-8 JSON is capped at 512 KiB per response, 128 KiB per message, 64 KiB for text, and 8 KiB per tool field. Each message returns up to 12 process entries within a 64 KiB process budget, with truncation and omitted-entry indicators. Only requested sequences and their selected tool call IDs have bodies extracted. Nested tool content has depth and block-count guards. Missing or over-budget logs retain previews and display a notice with the existing DSH opening action.

Closed logs are read from a size-pinned file snapshot of at most 8 MiB compressed. Zstd frame boundaries are parsed structurally, including skippable frames and incomplete append tails; production decompression is asynchronous, capped at 8 MiB per frame and 32 MiB overall, with a 2 MiB JSONL line limit. Only bounded selected events are retained, and text is copied into independent backing allocations so short V8 slices cannot retain large JSON lines. The LRU cache has at most four entries and an 8 MiB conservative accounting budget (serialized size × 3 plus key and object allowance); this is an accounting limit, not an exact V8 heap measurement. Identical reads share a promise, with at most two readers active and sixteen distinct reads pending. Unrelated raw history is scanned under these limits but not cached. Workspace projection paging remains a later step.

`browser-cache.js` owns the frontend cache and request lifecycle. The body LRU has a 16 MiB accounting budget and at most 512 messages, including text, process payloads, revision strings and key/object allowances. The Markdown LRU has a 4 MiB budget and at most 256 entries; input keys and rendered HTML both count, entries larger than 512 KiB are not cached, and streaming partial replies bypass this cache. Browser accounting uses two bytes per UTF-16 code unit plus object allowances; these numbers are not an exact browser heap or DOM limit.

Retained canvas graph cards hold only previews. Hydrated cards are temporary rendering objects, so evicted bodies are not kept alive by the graph. Up to 256 currently wanted messages are tracked, with two concurrent requests and batches of 20. The loader follows byte-limited response cursors. Departing messages abort their requests; response acceptance and final cleanup check request identity as well as current wanted-message revision. Tool metadata changes invalidate earlier bodies. A canceled request neither becomes a failure nor interferes with a replacement request for the same sequence.

Workspace changes clear body/Markdown caches and graph references. Removed or archived threads lose their entries and outstanding requests; transient scroll, expansion, page and live-reply state is pruned. The bridge sends `synapse:map-closed` even though a hidden iframe does not receive a page visibility change. Closing the map, hiding the browser tab or unloading it aborts body requests and releases rendered body DOM; reopening keeps camera state and hydrates the current view. Already cached messages remain reusable across detail/canvas changes. Failures or visible entries evicted under memory pressure are attempted once per visit, so a large viewport cannot create a fetch/eviction loop; entering another detail/page can retry. Total workspace projection data and the currently rendered DOM are outside the cache budgets.

Projection writes are coalesced during event bursts, and live updates reuse cached Markdown and patch the active card instead of rebuilding the complete canvas. Card coordinates remain visual metadata only and never determine conversation lineage.

Archiving is owned by DSH. The map mirrors `archivedSessionIds` from the Workspace snapshot to stop drawing cards for archived sessions, and its own archive action calls the Workspace `archiveSession` so both sides share one archive set (issue #21 / #19).

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

- The bundled patch applies to any profile that lists the package as a bundle (`desktop`, `web`); a profile that does not list it stays untouched.
- Canvas metadata and session content have different owners and backup requirements.
- A single shared metadata file is not a multi-writer database.
- Browser state can be cleared independently from DSH Home data.
- Historical migrations may have less precise tool-call pairing than live projection.

## Related documentation

- [Chinese user guide](zh-CN/README.md)
- [English user guide](en/README.md)
- [Development and release guide](development.md)
- [Project overview](../README.md)
