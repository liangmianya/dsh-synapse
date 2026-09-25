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
      const style = document.createElement('style')
      style.textContent = '.dsh-synapse-switch{position:fixed;z-index:80;top:12px;left:50%;display:flex;gap:2px;transform:translateX(-50%);border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px)}.dsh-synapse-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-synapse-switch button:hover{background:#f3f4f6;color:#111827}.dsh-synapse-switch button.active{background:#111827;color:#fff}.dsh-synapse-switch button:focus-visible{outline:2px solid #111827;outline-offset:2px}.dsh-synapse-overlay{position:fixed;z-index:100;inset:0;background:#f5f7fa}.dsh-synapse-overlay.is-opening{visibility:hidden}.dsh-synapse-overlay[hidden]{display:none}.dsh-synapse-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-synapse-host'
      host.innerHTML = '<div class="dsh-synapse-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">会话地图</button></div><section class="dsh-synapse-overlay" hidden><iframe title="会话地图" src="/synapse/"></iframe></section>'
      document.body.append(host)
      const dialogButton = host.querySelector('[data-view="dialog"]')
      const mapButton = host.querySelector('[data-view="map"]')
      const overlay = host.querySelector('.dsh-synapse-overlay')
      const frame = host.querySelector('iframe')

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
          const wanted = rows.byId[id]?.running === true && ctx.sessions.binding(id) === undefined
          if (wanted && !held) {
            try {
              const reference = ctx.sessions.retain(id, { source: SESSION_SOURCE })
              void reference.ready.catch(() => {})
              ownReferences.set(id, reference)
            } catch { /* the Session is not retainable right now */ }
          } else if (!wanted && held) {
            ownReferences.get(id).release()
            ownReferences.delete(id)
          }
        }
        for (const [id, reference] of ownReferences) {
          if (rows.ids.includes(id)) continue
          reference.release()
          ownReferences.delete(id)
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
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
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
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
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
        themeObserver?.disconnect()
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const record of liveSessions.values()) detachLiveSession(record)
        liveSessions.clear()
        for (const reference of ownReferences.values()) reference.release()
        ownReferences.clear()
        host.remove()
        style.remove()
      }, 'synapse: web workspace switch')
    }
    return module.exports
  },
})
