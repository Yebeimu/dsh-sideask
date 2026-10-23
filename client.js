// dsh-sideask 的客户端半：侧栏底部一个「待答 N」，点了在旁边浮一张卡。
//
// 形态：攒着、点了再看、不挡主页面、和会话区分开、只看单工作区。
//   一、入口放 sidebar.footer.action，平时只有几个字，没有待答时完全不显示。
//   二、卡片挂 shell.overlay，贴左下角，不遮中间内容，点 × 或按 Esc 收起。
//   三、卡片里每条写清「哪个会话 + 问什么 + 有哪些选项」，跟当前会话的输入区完全分开。
//
// 数据来源是 host 半的两个路由：GET /dsh-sideask/list、POST /dsh-sideask/answer。

window.__ModuleLoader__.load({
  id: '@local/dsh-sideask',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    let services = null

    // 两个 slot 之间共享开合状态
    let open = false
    const subs = new Set()
    function emit() { for (const fn of subs) { try { fn() } catch (e) {} } }
    function setOpen(v) { open = v; emit() }
    function useSharedOpen() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => {
        subs.add(force)
        return () => { subs.delete(force) }
      }, [])
      return open
    }

    // 客户端插件的 ctx 上直接读 ctx.remote 常常拿不到，但 Context 有 get()，
    // 不声明 inject 也能取可选服务。两条都试，都没有就走 host 路由。
    function remoteOf() {
      try {
        const c = services
        if (!c) return null
        if (typeof c.get === 'function') {
          const r = c.get('remote')
          if (r) return r
        }
        if (c.remote) return c.remote
      } catch (e) {}
      return null
    }

    let cache = { items: [], baseCwd: '' }
    // 提交成功后本地立刻收掉。不这样的话，面板要等对面 tool/result 才消失，
    // 中间那段时间还列着，看起来像没发出去。
    const sentKeys = new Set()

    // 2026-10-18：当前会话的 cwd 由 FootAction 从 slot props 的 useSessions 读出来写在这里。
    // 原来调 sessions.list.getSnapshot / sessions.current 那一套，0.2.1 的 client 端 sessions
    // 服务里没有这些方法，永远返回空；空就不带参数，服务端 baseCwd 也为空，单工作区过滤退化成
    // 返回全部。现在直接传 cwd。
    let currentCwd = ''

    async function refresh() {
      try {
        const q = currentCwd ? ('?cwd=' + encodeURIComponent(currentCwd)) : ''
        const r = await fetch('/dsh-sideask/list' + q, { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json()
          // 拉回来的也要过一遍「已发」名单。服务端要等这一轮收尾才划掉那条，
          // 中间它还会被拉回来，不过滤的话侧栏计数会重新亮起来。
          cache = { ...d, items: (d.items || []).filter((x) => !sentKeys.has(x.key)) }
        }
      } catch (e) {}
      emit()
      return cache
    }

    async function submit(item, answers) {
      // 先走客户端自己的远程接口，跟原生问答卡片同一条路。走这条 DSH 会更新投影，
      // 会话里那张卡片跟着收起来；走 host 那条答案能送到，但原生卡片不知道，会一直显示等待。
      try {
        const rp = remoteOf()
        const rpc = rp && rp.userQuestions
        if (rpc && typeof rpc.answer === 'function') {
          const r = await rpc.answer(item.sessionId, item.callId, answers)
          if (r && r.ok === false) {
            return { ok: false, why: (r.error && r.error.message) || '远程接口拒绝' }
          }
          return { ok: true, via: 'remote' }
        }
      } catch (e) {
        // remote 不可用就落到下面，别把这条路当成唯一的
      }
      try {
        const r = await fetch('/dsh-sideask/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sessionId, callId: item.callId, answers }),
        })
        const d = await r.json().catch(() => ({}))
        return d
      } catch (e) {
        return { ok: false, why: String((e && e.message) || e) }
      }
    }

    // ── 一张卡：一个会话挂着的所有问题 ──────────────────────────
    function AskCard(props) {
      const item = props.item
      const questions = item.questions || []
      const [picked, setPicked] = React.useState({})   // questionId -> string[]
      const [custom, setCustom] = React.useState({})   // questionId -> 自己写的内容
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')

      const pick = (q, label) => {
        setPicked((prev) => {
          const cur = prev[q.id] || []
          if (q.multiSelect) {
            const next = cur.includes(label) ? cur.filter((x) => x !== label) : cur.concat([label])
            return { ...prev, [q.id]: next }
          }
          return { ...prev, [q.id]: [label] }
        })
        setErr('')
      }

      const ready = questions.every((q) =>
        (picked[q.id] || []).length > 0 || String(custom[q.id] || '').trim().length > 0)

      const onSubmit = async () => {
        if (!ready || busy) return
        setBusy(true)
        const answers = questions.map((q) => {
          const sel = picked[q.id] || []
          const cus = String(custom[q.id] || '').trim()
          return cus ? { id: q.id, selected: sel, custom: cus } : { id: q.id, selected: sel }
        })
        const d = await submit(item, answers)
        setBusy(false)
        if (!d || !d.ok) { setErr((d && d.why) || '没送出去'); return }
        // 直接改缓存：面板列表和侧栏计数都读它，改一处两边一起清。
        sentKeys.add(item.key)
        cache = { ...cache, items: (cache.items || []).filter((x) => x.key !== item.key) }
        emit()
        await refresh()
      }

      const chip = (active) => ({
        padding: '4px 10px', borderRadius: '999px', cursor: 'pointer',
        fontSize: '12px', lineHeight: 1.6,
        border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary, #4c7dff)' : 'var(--dsw-alias-border-l1, #3a3f52)'),
        background: active ? 'var(--dsw-alias-brand-primary, #4c7dff)' : 'transparent',
        color: active ? '#fff' : 'inherit',
      })

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1, #3a3f52)',
          borderRadius: '8px', padding: '8px 10px', marginBottom: '8px',
        },
      },
        h('div', {
          style: {
            fontSize: '11px', opacity: 0.6, marginBottom: '4px', letterSpacing: '0.3px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
          title: item.title || item.sessionId,
        }, item.title || ('会话 ' + String(item.sessionId).replace(/^session-/, '').slice(0, 8))),
        questions.map((q) => h('div', { key: q.id, style: { marginBottom: '6px' } },
          h('div', { style: { marginBottom: '4px', fontSize: '13px' } }, q.question),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
            (q.options || []).map((o) => h('button', {
              key: o.label,
              type: 'button',
              title: o.description || '',
              onClick: () => pick(q, o.label),
              style: chip((picked[q.id] || []).includes(o.label)),
            }, o.label)),
          ),
          h('input', {
            type: 'text',
            value: custom[q.id] || '',
            placeholder: '或者自己写一句',
            onChange: (e) => {
              const v = e.target.value
              setCustom((prev) => ({ ...prev, [q.id]: v }))
              setErr('')
            },
            style: {
              marginTop: '6px', width: '100%', boxSizing: 'border-box',
              padding: '4px 8px', fontSize: '12px', lineHeight: 1.5,
              background: 'transparent', color: 'inherit',
              border: '1px solid var(--dsw-alias-border-l1, #3a3f52)',
              borderRadius: '6px', outline: 'none',
            },
          }),
        )),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
          h('button', {
            type: 'button',
            disabled: !ready || busy,
            onClick: onSubmit,
            style: {
              padding: '4px 12px', borderRadius: '6px', fontSize: '12px',
              cursor: ready && !busy ? 'pointer' : 'default',
              opacity: ready && !busy ? 1 : 0.45,
              border: 'none',
              background: 'var(--dsw-alias-brand-primary, #4c7dff)', color: '#fff',
            },
          }, busy ? '发送中…' : '发送答案'),
          err ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #d4380d)' } }, err) : null,
        ),
      )
    }

    // ── 左下角浮层 ────────────────────────────────────────────
    function Panel() {
      const isOpen = useSharedOpen()
      const [raw, setItems] = React.useState(cache.items || [])
      const items = (raw || []).filter((it) => !sentKeys.has(it.key))

      React.useEffect(() => {
        subs.add(() => setItems([...(cache.items || [])]))
        return () => {}
      }, [])

      React.useEffect(() => {
        if (isOpen) refresh()
      }, [isOpen])

      React.useEffect(() => {
        if (!isOpen) return
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [isOpen])

      if (!isOpen) return null

      return h('div', {
        style: {
          position: 'fixed', left: '12px', bottom: '56px', width: '330px',
          maxHeight: '62vh', overflowY: 'auto',
          padding: '10px 10px 6px',
          background: 'var(--dsw-alias-bg-overlay, #1f2230)',
          color: 'var(--dsw-alias-label-primary, #e6e8ef)',
          border: '1px solid var(--dsw-alias-border-l1, #3a3f52)',
          borderRadius: '10px',
          boxShadow: '0 6px 18px rgba(0,0,0,0.14)',
          fontSize: '13px', zIndex: 3000,
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
        },
          h('span', { style: { fontSize: '12px', opacity: 0.75 } },
            items.length ? ('别的会话在等 ' + items.length + ' 件') : '没有等答的问题'),
          h('button', {
            type: 'button', onClick: () => setOpen(false),
            style: {
              border: 'none', background: 'transparent', color: 'inherit',
              cursor: 'pointer', fontSize: '14px', lineHeight: 1, opacity: 0.6,
            },
          }, '×'),
        ),
        items.length
          ? items.map((it) => h(AskCard, { key: it.key, item: it }))
          : h('div', { style: { fontSize: '12px', opacity: 0.55, paddingBottom: '8px' } },
              '同一个工作区里没有别的会话在等我。'),
      )
    }

    // ── 侧栏底部的入口 ────────────────────────────────────────
    function FootAction(props) {
      const isOpen = useSharedOpen()
      const [count, setCount] = React.useState((cache.items || []).length)

      // slot 的 standardProps 里只有 useSessions 这一串钩子，没有 sessionId。
      // 当前会话 id 从侧栏树的选中行读：aria-selected 的那个 treeitem，data-row-key 形如
      // session:session-xxx。拿到 id 再用 useSessions 的 byId 查它的 cwd。
      const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      const snap = useSessions ? useSessions(function (s) { return s }) : null

      function selectedSessionId() {
        try {
          const el = document.querySelector('[data-slot="sidebar"] [role="treeitem"][aria-selected="true"]')
          const k = el && el.getAttribute('data-row-key')
          if (k && k.indexOf('session:') === 0) return k.slice(8)
        } catch (e) {}
        return ''
      }

      React.useEffect(() => {
        const apply = () => {
          const sid = selectedSessionId()
          if (!sid) return
          const cwd = snap && snap.byId && snap.byId[sid] ? String(snap.byId[sid].cwd || '') : ''
          if (cwd && cwd !== currentCwd) {
            currentCwd = cwd
            refresh()
          }
        }
        apply()
        const t = setInterval(apply, 3000)
        return () => clearInterval(t)
      }, [snap])

      React.useEffect(() => {
        subs.add(() => setCount((cache.items || []).length))
        const t = setInterval(refresh, 4000)
        return () => clearInterval(t)
      }, [])

      // 没有待答时不常驻，别在侧栏留一个「待答 0」。
      if (!count) return null

      return h('button', {
        type: 'button',
        onClick: () => { setOpen(!open); if (!open) refresh() },
        title: '别的会话挂着的提问（点了看，不挡当前会话）',
        'data-di-sideask': isOpen ? 'open' : 'closed',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          height: '28px', padding: '0 8px',
          background: isOpen ? 'var(--dsw-alias-bg-overlay, #1f2230)' : 'transparent',
          color: 'inherit', border: 'none', borderRadius: '6px',
          cursor: 'pointer', fontSize: '12px',
          color: 'var(--dsw-alias-label-secondary, #8c8c8c)',
        },
      }, '待答', count ? (' ' + count) : '')
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        services = ctx
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-sideask',
          order: 30,
        }, FootAction))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-sideask-panel',
          order: 60,
        }, Panel))
      },
    }
  },
})
