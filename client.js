window.__ModuleLoader__.load({
  id: 'dsh-synapse',
  factory: () => {
    const module = { exports: {} }
    // Consumer identity for owned Session references. The Client records
    // positive reference counts per source; nothing else reads this string.
    const SESSION_SOURCE = 'synapse'
    // Shown when a Session is gone or no longer reachable from this browser.
    const NO_SESSION = '关联的 DSH 会话已不可用'
    const currentSession = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      // 0.1.7 removed `list.current`: the Main view's own reference count is the
      // Client's current-Session signal. `ui-workspace` derives the highlighted
      // Session row from the same fact, so both stay in step by construction.
      const session = Object.values(snapshot.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)
      return session === undefined ? null : { id: session.id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map(id => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = ctx => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
      return [
        ...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
        { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
      ]
    }
    // DSH owns which Sessions are archived. The map mirrors that set so an
    // archived Session stops drawing cards, and archives through the same
    // Workspace action instead of keeping a second hidden list (#21 / #19).
    const archivedSessionIds = ctx => {
      const snapshot = ctx.workspaces.list.getSnapshot()
      return Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds.map(String) : []
    }

    // The pill can be dragged anywhere it stays reachable; the position survives
    // reloads. Kept next to the module so the drag arithmetic is testable without
    // a DOM (see test/switch-drag.test.js).
    const SWITCH_POSITION_KEY = 'dsh-synapse:switch-position:v1'
    const SWITCH_MARGIN = 8
    const SWITCH_STEP = 8

    /** Keep the pill fully inside the viewport, with a margin to grab it again. */
    function clampSwitchPosition(position, viewport, size) {
      const maxLeft = Math.max(SWITCH_MARGIN, viewport.width - size.width - SWITCH_MARGIN)
      const maxTop = Math.max(SWITCH_MARGIN, viewport.height - size.height - SWITCH_MARGIN)
      return {
        left: Math.min(Math.max(SWITCH_MARGIN, Math.round(position.left)), maxLeft),
        top: Math.min(Math.max(SWITCH_MARGIN, Math.round(position.top)), maxTop),
      }
    }

    function readSwitchPosition(storage) {
      try {
        const value = JSON.parse(storage.getItem(SWITCH_POSITION_KEY) ?? 'null')
        if (value === null || typeof value !== 'object') return null
        if (!Number.isFinite(value.left) || !Number.isFinite(value.top)) return null
        return { left: Math.round(value.left), top: Math.round(value.top) }
      } catch {
        return null
      }
    }

    function writeSwitchPosition(storage, position) {
      try { storage.setItem(SWITCH_POSITION_KEY, JSON.stringify(position)) } catch { /* private mode */ }
    }

    function clearSwitchPosition(storage) {
      try { storage.removeItem(SWITCH_POSITION_KEY) } catch { /* private mode */ }
    }

    module.exports.inject = ['sessions', 'workspaces', 'uiWorkspace', 'uiConversation']
    module.exports.apply = ctx => {
      const prompt = async (sessionId, text) => {
        // 0.1.7 owns Session lifetime explicitly: `scope()` only borrows an
        // already-retained generation, so sending needs a reference of our own.
        let reference
        try {
          reference = ctx.sessions.retain(sessionId, { source: SESSION_SOURCE })
          await reference.ready
        } catch {
          reference?.release()
          throw new Error(NO_SESSION)
        }
        try {
          const result = await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
          if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
        } finally {
          reference.release()
        }
      }
      // Mounting is idempotent. A hot-reloaded or re-applied instance used to
      // leave the previous pill (and its overlay) on the page, which showed up
      // as two switches at different offsets. Drop whatever a previous instance
      // left behind, including a pill the reverted header-slot build moved into
      // the Conversation header.
      for (const stale of document.querySelectorAll('.dsh-synapse-host, .dsh-synapse-switch')) stale.remove()
      const style = document.createElement('style')
      // One coordinate, in both views. The switch is a page-level control, so it
      // never takes part in the Conversation header layout: seating it in a slot
      // made it jump between the header utilities and this position on every
      // view change. Three details keep the single seat usable:
      //   - `z-index` above the map overlay, so the map can always be left;
      //   - `-webkit-app-region: no-drag`, because the pill sits below the
      //     Windows title-bar drag band and would otherwise swallow no clicks;
      //   - the `left` offset clears the header's left-hand content, which grows
      //     rightward (title, lineage and agent-preset chips). Half the sidebar
      //     width puts the pill over the centre of the content area instead of
      //     the window; `min()` pulls it back in on narrow windows.
      style.textContent = '.dsh-synapse-switch{position:fixed;z-index:200;top:calc(var(--dsh-frame-chrome-top,var(--dsh-frame-top-clearance,0px)) + 12px);left:min(calc(50% + 130px),calc(100% - 96px));display:flex;gap:2px;transform:translateX(-50%);border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px);-webkit-app-region:no-drag;box-shadow:0 2px 8px rgba(17,24,39,.1)}.dsh-synapse-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag}.dsh-synapse-switch button:hover{background:#f3f4f6;color:#111827}.dsh-synapse-switch button.active{background:#111827;color:#fff}.dsh-synapse-switch button:focus-visible{outline:2px solid #111827;outline-offset:2px}.dsh-synapse-overlay{position:fixed;z-index:100;inset:var(--dsh-frame-chrome-top,var(--dsh-frame-top-clearance,0px)) 0 0 0;background:#f5f7fa}.dsh-synapse-overlay.is-opening{visibility:hidden}.dsh-synapse-overlay[hidden]{display:none}.dsh-synapse-overlay iframe{display:block;width:100%;height:100%;border:0}html[data-fullscreen] .dsh-synapse-overlay{top:0}html[data-fullscreen] .dsh-synapse-switch{top:12px}.dsh-synapse-grip{display:grid;width:16px;height:28px;place-items:center;border-radius:999px;color:#9ca3af;background:transparent;cursor:grab;touch-action:none;-webkit-app-region:no-drag}.dsh-synapse-grip:hover{background:#f3f4f6;color:#4b5563}.dsh-synapse-grip:focus-visible{outline:2px solid #111827;outline-offset:2px}.dsh-synapse-grip svg{width:8px;height:14px;fill:currentColor}.dsh-synapse-switch.is-dragging .dsh-synapse-grip{cursor:grabbing}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-synapse-host'
      host.innerHTML = '<div class="dsh-synapse-switch" role="group" aria-label="视图切换"><span class="dsh-synapse-grip" role="button" tabindex="0" aria-label="拖动位置" title="拖动位置（双击复位，方向键微调）"><svg aria-hidden="true" viewBox="0 0 8 14"><circle cx="2" cy="2" r="1.3"/><circle cx="6" cy="2" r="1.3"/><circle cx="2" cy="7" r="1.3"/><circle cx="6" cy="7" r="1.3"/><circle cx="2" cy="12" r="1.3"/><circle cx="6" cy="12" r="1.3"/></svg></span><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">会话地图</button></div><section class="dsh-synapse-overlay" hidden><iframe title="会话地图" src="/synapse/"></iframe></section>'
      document.body.append(host)
      const switchEl = host.querySelector('.dsh-synapse-switch')
      // Two live instances (a bundle loaded twice, or a sibling that outlived a
      // redeploy) each mount a pill; no instance can see the other's apply. Let
      // them converge instead of racing: every pill carries its mount stamp and
      // every instance keeps the newest one, breaking ties on document order, so
      // both sides agree on the same winner without a reload.
      switchEl.dataset.mountedAt = String(Date.now())
      const convergeSwitch = () => {
        const pills = [...document.querySelectorAll('.dsh-synapse-switch')]
        if (pills.length < 2) return
        let keep = pills[0]
        for (const pill of pills) {
          const stamp = Number(pill.dataset?.mountedAt ?? 0)
          const best = Number(keep.dataset?.mountedAt ?? 0)
          if (stamp > best || (stamp === best && pills.indexOf(pill) > pills.indexOf(keep))) keep = pill
        }
        for (const pill of pills) if (pill !== keep) pill.remove()
      }
      convergeSwitch()
      const convergeSwitchLater = window.setTimeout(convergeSwitch, 500)
      const dialogButton = host.querySelector('[data-view="dialog"]')
      const mapButton = host.querySelector('[data-view="map"]')
      const overlay = host.querySelector('.dsh-synapse-overlay')
      const frame = host.querySelector('iframe')
      const grip = host.querySelector('.dsh-synapse-grip')

      // --- dragging the pill -------------------------------------------------
      // A stored position switches the pill from its CSS seat (centred, under the
      // window chrome) to explicit viewport coordinates; `transform` has to be
      // dropped with it or the pill would stay half a width to the left.
      const switchSize = () => ({ width: switchEl.offsetWidth, height: switchEl.offsetHeight })
      const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight })
      const applySwitchPosition = position => {
        if (position === null) {
          switchEl.style.removeProperty('left')
          switchEl.style.removeProperty('top')
          switchEl.style.removeProperty('transform')
          return
        }
        switchEl.style.left = `${position.left}px`
        switchEl.style.top = `${position.top}px`
        switchEl.style.transform = 'none'
      }
      const storedSwitchPosition = readSwitchPosition(window.localStorage)
      if (storedSwitchPosition !== null) {
        applySwitchPosition(clampSwitchPosition(storedSwitchPosition, viewportSize(), switchSize()))
      }
      let switchDrag = null
      const finishSwitchDrag = event => {
        if (switchDrag === null) return
        const drag = switchDrag
        switchDrag = null
        switchEl.classList.remove('is-dragging')
        try { grip.releasePointerCapture(event.pointerId) } catch { /* already released */ }
        if (drag.moved && drag.position !== null) writeSwitchPosition(window.localStorage, drag.position)
      }
      grip.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        event.preventDefault()
        const rect = switchEl.getBoundingClientRect()
        switchDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false, position: null }
        switchEl.classList.add('is-dragging')
        try { grip.setPointerCapture(event.pointerId) } catch { /* capture is best effort */ }
      })
      grip.addEventListener('pointermove', event => {
        if (switchDrag === null) return
        const dx = event.clientX - switchDrag.x
        const dy = event.clientY - switchDrag.y
        if (!switchDrag.moved && Math.hypot(dx, dy) < 3) return
        switchDrag.moved = true
        switchDrag.position = clampSwitchPosition({ left: switchDrag.left + dx, top: switchDrag.top + dy }, viewportSize(), switchSize())
        applySwitchPosition(switchDrag.position)
      })
      grip.addEventListener('pointerup', finishSwitchDrag)
      grip.addEventListener('pointercancel', finishSwitchDrag)
      // Double-click resets the pill to its shipped seat.
      grip.addEventListener('dblclick', () => {
        clearSwitchPosition(window.localStorage)
        applySwitchPosition(null)
      })
      // Keyboard path: arrows nudge, so the control is usable without a pointer.
      grip.addEventListener('keydown', event => {
        const step = { ArrowLeft: [-SWITCH_STEP, 0], ArrowRight: [SWITCH_STEP, 0], ArrowUp: [0, -SWITCH_STEP], ArrowDown: [0, SWITCH_STEP] }[event.key]
        if (step === undefined) return
        event.preventDefault()
        const rect = switchEl.getBoundingClientRect()
        const position = clampSwitchPosition({ left: rect.left + step[0], top: rect.top + step[1] }, viewportSize(), switchSize())
        applySwitchPosition(position)
        writeSwitchPosition(window.localStorage, position)
      })
      const keepSwitchInView = () => {
        const stored = readSwitchPosition(window.localStorage)
        if (stored !== null) applySwitchPosition(clampSwitchPosition(stored, viewportSize(), switchSize()))
      }
      window.addEventListener('resize', keepSwitchInView)

      const setView = view => {
        const showingMap = view === 'map'
        dialogButton.classList.toggle('active', !showingMap)
        dialogButton.setAttribute('aria-pressed', String(!showingMap))
        mapButton.classList.toggle('active', showingMap)
        mapButton.setAttribute('aria-pressed', String(showingMap))
      }
      const close = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.classList.remove('is-opening')
        overlay.hidden = true
        setView('dialog')
      }
      const send = (type, payload) => { frame.contentWindow?.postMessage({ source: 'dsh-synapse', type, ...payload }, location.origin) }
      let syncQueued = false
      let knownSessionIds = new Set()
      // One live record per catalogued Session. The pre-0.1.7 Client minted a
      // Session scope on demand for any listed id, so live state was readable
      // for every card; 0.1.7 mints none, so a Chat view is readable only while
      // something holds a reference. A card whose Session is not observable
      // still reports its `running` flag from the list row, because only the
      // streaming text needs the view.
      const liveSessions = new Map()
      // References this plugin owns, so it can read a running Session's Chat
      // view without depending on another surface retaining it.
      const ownReferences = new Map()

      const publishLiveSession = id => {
        if (overlay.hidden) return
        const text = liveSessions.get(id)?.chat?.getSnapshot()?.legacy.partial?.blocks
          .filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
        const running = ctx.sessions.list.getSnapshot().byId[id]?.running === true
        send('synapse:live-reply', { sessionId: id, running, text })
      }

      const detachLiveSession = record => {
        for (const unsubscribe of record.unsubscribers) unsubscribe()
      }

      // A running Session is the only kind that produces live text, so it is the
      // only kind worth opening a reference — and its history read — for.
      const syncObservedSessions = () => {
        const rows = ctx.sessions.list.getSnapshot()
        for (const id of rows.ids) {
          const held = ownReferences.has(id)
          // Retaining creates the binding, so a binding this plugin holds does not
          // count as another view of the Session.
          const wanted = rows.byId[id]?.running === true && (held || ctx.sessions.binding(id) === undefined)
          if (wanted && !held) {
            try {
              const reference = ctx.sessions.retain(id, { source: SESSION_SOURCE })
              void reference.ready.catch(() => {})
              ownReferences.set(id, reference)
            } catch { /* the Session is not retainable right now */ }
          } else if (!wanted && held) {
            // Forget the reference first: release() republishes the list, which
            // re-enters this function synchronously.
            const reference = ownReferences.get(id)
            ownReferences.delete(id)
            reference.release()
          }
        }
        for (const [id, reference] of ownReferences) {
          if (rows.ids.includes(id)) continue
          ownReferences.delete(id)
          reference.release()
        }
      }

      const syncLiveSessions = () => {
        syncObservedSessions()
        const ids = ctx.sessions.list.getSnapshot().ids
        for (const id of ids) {
          const binding = ctx.sessions.binding(id)
          let record = liveSessions.get(id)
          // Rebuild when the observable source appears or disappears, and when a
          // same-id generation replaced the borrowed binding.
          if (record !== undefined && record.binding !== binding) {
            detachLiveSession(record)
            record = undefined
          }
          if (record === undefined) {
            let chat
            if (binding !== undefined) {
              try { chat = ctx.uiConversation.binding(id).target('chat') } catch { chat = undefined }
            }
            liveSessions.set(id, {
              binding,
              chat,
              // `target('chat')` is the only reader that activates the view
              // target: its snapshot stays undefined until something subscribes.
              unsubscribers: chat === undefined
                ? []
                : [chat.subscribe(() => publishLiveSession(id)), binding.session.subscribe(() => publishLiveSession(id))],
            })
          }
        }
        for (const [id, record] of liveSessions) {
          if (ids.includes(id)) continue
          detachLiveSession(record)
          liveSessions.delete(id)
        }
      }
      // Always runs after `syncLiveSessions`, so a newly attached Session gets
      // its first report here rather than publishing twice on the same sync.
      const publishLiveSessions = () => { for (const id of liveSessions.keys()) publishLiveSession(id) }
      const syncSessions = () => {
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          void fetch('/synapse/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        })
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        send('synapse:theme', { dark })
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        publishLiveSessions()
        syncTheme()
        if (!overlay.hidden) {
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx), archivedSessionIds: archivedSessionIds(ctx) })
          send('synapse:current-session', { session: currentSession(ctx) })
        }
      }
      let mapOpenFallback = 0
      let mapOpening = false
      const showMapOverlay = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.hidden = false
        overlay.classList.remove('is-opening')
        syncCurrentSession()
      }
      const open = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = true
        setView('map')
        // Keep the iframe laid out while hidden so its canvas can receive a
        // real scroll offset. display:none would clamp scrollTop back to zero.
        overlay.hidden = false
        overlay.classList.add('is-opening')
        window.requestAnimationFrame(() => {
          send('synapse:map-opened')
          syncCurrentSession()
        })
        mapOpenFallback = window.setTimeout(showMapOverlay, 300)
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        if (mapOpening) send('synapse:map-opened')
      }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-synapse') return
        if (event.data.type === 'synapse:close') return close()
        if (event.data.type === 'synapse:map-ready') return showMapOverlay()
        if (event.data.type === 'synapse:request-current') {
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx), archivedSessionIds: archivedSessionIds(ctx) })
          return send('synapse:current-session', { session: currentSession(ctx) })
        }
        if (event.data.type === 'synapse:open-session') {
          // 0.1.7 moved navigation out of the Session Controller: selecting a
          // Session and showing its Conversation is one Workspace UI action.
          try { ctx.uiWorkspace.openSession(event.data.sessionId); close() } catch { send('synapse:bridge-error', { message: NO_SESSION }) }
          // Best-effort anchor to the requested turn: chat nodes expose their
          // source event seq (anchorSeq) and render with data-chat-anchor-key,
          // so resolve seq -> node key -> scroll once the view materializes.
          const seq = event.data.seq
          if (Number.isInteger(seq)) {
            const tryScroll = attempt => {
              const record = liveSessions.get(event.data.sessionId)
              if (record === undefined) {
                if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
                return
              }
              let key = undefined
              for (const node of record.chat.getSnapshot()?.nodes.values() ?? []) {
                if (node.anchorSeq === seq) { key = node.key; break }
              }
              if (key !== undefined) {
                const row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
                if (row instanceof HTMLElement) row.scrollIntoView({ block: 'start' })
                return
              }
              // The requested turn may sit outside the loaded window; the jump
              // loader pages history back through the seq, then the retry reads
              // the rebuilt node set.
              if (attempt === 0 && typeof record.session.loadThrough === 'function') {
                void record.session.loadThrough(seq).catch(() => {})
              }
              if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
            }
            window.setTimeout(() => tryScroll(0), 300)
          }
          return
        }
        if (event.data.type === 'synapse:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without closing the map; the sessions-list subscription re-sends
          // synapse:current-session so the map follows the new highlight.
          try { ctx.uiWorkspace.openSession(event.data.sessionId) } catch { send('synapse:bridge-error', { message: NO_SESSION }) }
          return
        }
        if (event.data.type === 'synapse:archive-session') {
          // One archive set only: archive through the Workspace action so DSH's
          // sidebar and this map agree, then acknowledge the request so the map
          // can hide the card instead of silently diverging (#21 / #19).
          const sessionId = event.data.sessionId
          const requestId = event.data.requestId
          if (typeof sessionId !== 'string' || sessionId === '') return
          if (typeof ctx.workspaces.archiveSession !== 'function') {
            return send('synapse:bridge-error', { requestId, message: '当前 DSH 版本不支持归档接口' })
          }
          Promise.resolve()
            .then(() => ctx.workspaces.archiveSession(sessionId))
            .then(() => {
              send('synapse:archived-session', { requestId, sessionId })
              send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx), archivedSessionIds: archivedSessionIds(ctx) })
            })
            .catch(error => {
              send('synapse:bridge-error', { requestId, message: `DSH 归档失败：${error instanceof Error ? error.message : String(error)}` })
            })
          return
        }
        if (event.data.type === 'synapse:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('synapse:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('synapse:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (event.data.type === 'synapse:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('synapse:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            send('synapse:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('synapse:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (event.data.type === 'synapse:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('synapse:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { send('synapse:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      const onKeyDown = event => { if (event.key === 'Escape' && !overlay.hidden) close() }
      // Follow DSH's live theme switch: body[data-ds-dark-theme] is the web
      // client's dark-mode signal, mirrored into the map iframe via synapse:theme.
      const themeObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => syncTheme())
      if (themeObserver !== null && document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      }
      const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
      dialogButton.addEventListener('click', close)
      mapButton.addEventListener('click', open)
      frame.addEventListener('load', onFrameLoad)
      window.addEventListener('message', onMessage)
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => () => {
        dialogButton.removeEventListener('click', close)
        mapButton.removeEventListener('click', open)
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('resize', keepSwitchInView)
        themeObserver?.disconnect()
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const record of liveSessions.values()) detachLiveSession(record)
        liveSessions.clear()
        for (const reference of ownReferences.values()) reference.release()
        ownReferences.clear()
        window.clearTimeout(convergeSwitchLater)
        host.remove()
        style.remove()
      }, 'synapse: web workspace switch')
    }
    return module.exports
  },
})
