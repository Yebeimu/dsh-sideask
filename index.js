// dsh-sideask —— 把别的会话里挂着没答的提问攒起来，侧栏底部一个计数，点了再看。
//
// 为什么要有它：DSH 的 ask_user_question 卡片只画在发起提问的那个会话里。人在会话 B 时，
// 会话 A 挂着的问题看不见，只能自己切过去翻。这个插件把它们收集到一处，在任意会话都能答。
//
// 做什么：
//   1. 监听所有会话的 session/event，看到 ask_user_question 的 tool/call 记一条待答。
//   2. tool/result 收尾时判断：如果结果是 timed 模式到期（pending），问题仍然可答，保留记录；
//      真被答掉了才划掉。
//   3. GET /dsh-sideask/list 返回当前工作区里还挂着的那些，带会话标题。
//   4. POST /dsh-sideask/answer 跨会话把答案交回去（userQuestions.answer 按会话 + 调用号）。
//
// 前提：ask_user_question 要工作在 timed 模式下，问题才会在超时后变「可答但没人等」。
// 全局默认是 blocking，那种模式下问题一直被前台等待占着，别的界面答不了。配置见 README。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const name = 'dsh-sideask'
const inject = ['webServer', 'agents', 'userQuestions']

// 排查日志。默认写系统临时目录；不想要日志就把 DI_SIDEASK_LOG 设成空字符串。
const LOG = process.env.DI_SIDEASK_LOG === ''
  ? ''
  : (process.env.DI_SIDEASK_LOG || path.join(os.tmpdir(), 'dsh-sideask.log'))

function log(line) {
  if (!LOG) return
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8') } catch {}
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => resolve(b))
    req.on('error', () => resolve(''))
  })
}

// key = `${sessionId}|${callId}`
const pending = new Map()
let order = 0

function cwdOfSession(session) {
  try {
    return String((session && session.header && session.header.cwd) || '')
  } catch { return '' }
}

// 会话标题来自 session/title 事件（SessionTitleEventData 里有 title 字段）。
// 拿不到才退回短 id —— 正常用户不认识 sessionId，别拿它当标签。
function titleOf(session) {
  try {
    const evs = (session && typeof session.ownEvents === 'function') ? session.ownEvents() : []
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i]
      if (e && e.type === 'session/title') {
        const t = String((e.data && e.data.title) || '').trim()
        if (t) return t
      }
    }
  } catch (e) {}
  return ''
}

// 挂着的提问最多留一天，防止长期不答的在面板里堆着。
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function cwdOfAgent(agent) {
  try {
    return String((agent && agent.session && agent.session.header && agent.session.header.cwd) || '')
  } catch { return '' }
}

export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || !event.type) return
      const sid = String((session && session.id) || '')
      if (!sid) return

      if (event.type === 'tool/call') {
        const d = event.data || {}
        if (String(d.name) !== 'ask_user_question') return
        const callId = String(d.callId || '')
        if (!callId) return
        let questions = []
        try {
          const args = JSON.parse(String(d.arguments || '{}'))
          questions = Array.isArray(args.questions) ? args.questions : []
        } catch (e) { log(`解析 ask_user_question 参数失败：${e && e.message ? e.message : e}`) }
        if (!questions.length) return
        const key = sid + '|' + callId
        pending.set(key, {
          key,
          sessionId: sid,
          callId,
          cwd: cwdOfSession(session),
          questions,
          at: Number(event.time) || Date.now(),
          order: ++order,
        })
        log(`记下待答 ${key} ${questions.length} 问`)
        return
      }

      // 工具调用收尾。注意 timed 模式下「到期」也会走到这里，返回的是 pending：
      // 那是放行模型继续干活，问题本身仍然可答，所以这时候不能划掉。
      if (event.type === 'tool/result') {
        const msg = (event.data && event.data.message) || {}
        const src = msg.source || {}
        const callId = String(src.callId || '')
        if (!callId) return
        const key = sid + '|' + callId
        let blob = ''
        try { blob = JSON.stringify(msg).slice(0, 6000) } catch (e) { blob = '' }
        const isPending = blob.indexOf('pending') >= 0 && blob.indexOf(callId) >= 0
        if (isPending) {
          if (pending.has(key)) log(`保留 ${key}（到期放行，仍可答）`)
          return
        }
        if (pending.delete(key)) log(`划掉 ${key}`)
        return
      }

      // 用户在原生的 ask_user_question 卡片上作答时，dsh-user-questions 会插一条 user message：
      //   source = { kind: 'user-question-reply', callId, outcome: 'answered' }
      // 那条消息就是关闭问题的记录。timed 模式到期已经返回过 pending，用户后来在原生卡片上答了，
      // 这边收不到别的通知，记录会一直挂到 MAX_AGE 才过期。
      // 判据用 source.kind，不看 content 里的文本（那段是 answer_to_pending_question 的 JSON 字符串）。
      {
        const d = event.data || {}
        const sources = [d.source, d.message && d.message.source].filter(Boolean)
        for (const s of sources) {
          if (String(s.kind || '') !== 'user-question-reply') continue
          const cid = String(s.callId || '')
          if (!cid) continue
          const k = sid + '|' + cid
          if (pending.delete(k)) log(`划掉（原生卡片作答）${k}`)
        }
      }

      // 回合结束不等于问题结束：到期挂起的提问跨回合有效。
      // 真正答掉时由 /dsh-sideask/answer 那条路划，或者过了 MAX_AGE 自动清。
      if (event.type === 'turn/end') return;
    } catch (e) {
      log(`session/event 出错：${e && e.message ? e.message : e}`)
    }
  }, { global: true })

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-sideask/list',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const want = String(url.searchParams.get('session') || '')
        const wantCwd = String(url.searchParams.get('cwd') || '')
        // 单工作区：以请求方所在会话的 cwd 为准，只返回同一个 cwd 的待答。
        // 2026-10-18：客户端直接传 cwd 时就用它。0.2.1 的 client 端 sessions 服务里没有
        // list / current / getSnapshot，插件拿不到当前会话 id，所以改由组件从 slot props 的
        // useSessions 读出 cwd 再传过来。session 参数留着，别的调用方还能用。
        let baseCwd = wantCwd
        if (!baseCwd && want) {
          const a = (ctx.agents.roots() || []).find(
            (x) => String((x.session && x.session.id) || '') === want,
          )
          if (a) baseCwd = cwdOfAgent(a)
        }
        const roots = ctx.agents.roots() || []
        const items = [...pending.values()]
          .filter((v) => (baseCwd ? v.cwd === baseCwd : true))
          .filter((v) => (Date.now() - (Number(v.at) || 0)) < MAX_AGE_MS)
          .sort((a, b) => a.order - b.order)
          .map((v) => {
            const a = roots.find((x) => String((x.session && x.session.id) || '') === v.sessionId)
            const live = a ? titleOf(a.session) : ''
            return { ...v, title: live || v.title || '' }
          })
        sendJson(res, 200, { items, baseCwd })
      } catch (e) {
        sendJson(res, 200, { items: [], error: String(e && e.message ? e.message : e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-sideask/answer',
    handler: async (req, res) => {
      const raw = await readBody(req)
      let data = {}
      try { data = JSON.parse(raw || '{}') } catch {}
      const sid = String(data.sessionId || '')
      const callId = String(data.callId || '')
      const answers = data.answers
      if (!sid || !callId || !answers) return sendJson(res, 400, { ok: false, why: '缺 sessionId / callId / answers' })
      // 把收到的东西原样打一行，排查「面板发了但没送到」时用得上。
      try { log(`收到回答 ${sid}|${callId} answers=${JSON.stringify(answers).slice(0, 300)}`) } catch (e) {}
      const agent = (ctx.agents.roots() || []).find(
        (a) => String((a.session && a.session.id) || '') === sid,
      )
      if (!agent) return sendJson(res, 200, { ok: false, why: '那个会话已经不在运行' })
      try {
        // answer 要的是 { answers: [...] } 这个对象，传裸数组会被判成没答上，返回 false。
        // stillOpen=true 才算送进去了；false 是没找到这个提问。
        const stillOpen = ctx.userQuestions.answer(agent, callId, { answers })
        log(`已答 ${sid}|${callId} stillOpen=${!!stillOpen}`)
        // true 才算送进去了（问题确实还在等）；false 是没找到这个提问，别把记录删掉。
        if (stillOpen) {
          pending.delete(sid + '|' + callId)
          log(`划掉（面板答上）${sid}|${callId}`)
        }
        sendJson(res, 200, { ok: true, stillOpen: !!stillOpen })
      } catch (e) {
        const m = String((e && e.message) || e)
        log(`回答失败 ${sid}|${callId}：${m}`)
        sendJson(res, 200, { ok: false, why: m })
      }
    },
  })

  log('host 半已挂载：/dsh-sideask/list、/dsh-sideask/answer')
}

export { inject, name }
