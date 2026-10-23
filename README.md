# dsh-sideask

在任意 DSH 会话里，查看并回答别的会话挂着的 `ask_user_question`，不用切过去。

**Powered by [DSH](https://github.com/deepseek-ai/deepseek-harness)**。

## 解决什么

DSH 只把 `ask_user_question` 的卡片画在发起提问的那个会话里。人在会话 B 干活时，会话 A 正等着一个回答，你既看不见，也没法在 B 处理。要么切过去翻，要么让那边干等。

## 做什么

- 把一个工作区里所有会话挂着的提问收在一起。
- 侧栏底部一个「待答 N」小按钮，没有待答时完全不显示。
- 点一下，左下角浮出面板：一个会话一张卡，写清会话标题、问题、选项，另带一个自由输入框。
- 提交后通过 `userQuestions.answer` 把答案送回发起提问的会话。

面板不占输入区，不抢焦点，不遮页面中间。

## 前提

- DSH `0.2.0` 及以上。
- **`ask_user_question` 必须工作在 `timed` 模式。**

这一条关键。默认的 `blocking` 模式下，提问一直停在前台等待，只有发起它的会话里的卡片能结算，任何外部界面都答不了。`timed` 模式到期后工具返回 `pending`，提问变成 *continued*：仍然可答，但不再归某一个界面独占。本插件接的就是这个状态。

在 profile 的 `cordis.patch.yml` 里给 `tool-ask-user` 那一行加配置：

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 60
```

这样提问在 `timeout` 秒之后就能从面板答。工具也接受每次调用自带的 `timeout` 参数，调用方想快一点可以传更小的值。

## 安装

1. 把包放进 profile 的插件目录，例如 `~/.dsh/profiles/desktop/plugins/dsh-sideask`。
2. 在 profile 的 `node_modules/@local` 下建一条与包名一致的链接：

   ```powershell
   New-Item -ItemType Junction `
     -Path  "$HOME\.dsh\profiles\desktop\node_modules\@local\dsh-sideask" `
     -Target "$HOME\.dsh\profiles\desktop\plugins\dsh-sideask"
   ```

3. 在 `cordis.patch.yml` 里加一行：

   ```yaml
   - id: dsh-sideask
     name: '@local/dsh-sideask'
   ```

4. 重启 DSH。客户端插件在启动时打包，刷新页面不够。

## 实现

两半。

**host 半** `index.js` 全局监听 `session/event`，用 `sessionId|callId` 作键维护一张待答表。

- 名字是 `ask_user_question` 的 `tool/call`：记下调用、问题、会话工作目录。
- `tool/result` 收尾时看结果：返回 `pending` 说明到期放行、问题仍可答，保留记录；其他结果说明问题已经结算，划掉。
- `turn/end` 不清表；到期挂起的提问跨回合有效。

两个 HTTP 路由：

- `GET /dsh-sideask/list?session=<id>` 返回工作目录与请求方一致的待答项，一个工作区与别的工作区分开。
- `POST /dsh-sideask/answer`，body 是 `{ sessionId, callId, answers }`，内部调 `ctx.userQuestions.answer(agent, callId, { answers })`。

**client 半** `client.js` 注册两个 slot：

- `sidebar.footer.action`：计数按钮，数量为 0 时不渲染。
- `shell.overlay`：面板，贴左下角，点 × 或按 Esc 收起。

计数按钮挂载期间每 4 秒拉一次列表，打开面板时立即刷新一次。

## 几个坑

- `userQuestions.answer` 要的是 `{ answers: [...] }` 对象，传裸数组会被判没答上，返回 `false`。
- `stillOpen === true` 才是答案进了队列；`false` 是没找到这个可答的提问。
- `pending` 的 tool 结果不是「答完了」。当成答完，问题会在没人回答时从面板消失。
- 提交成功后立刻从本地缓存里删掉那一条。等服务端划掉的话，中间有一段面板还列着已经答过的问题。

## 已知限制

- 只显示同一工作目录下的提问。
- 还在前台等待期内的问题不能从这里答，见「前提」。
- 待答记录在内存里，DSH 重启会清空；仍然可答的提问要等再次提问才会重新出现。
- 超过 24 小时的记录不再返回。

## 许可

MIT

---

# dsh-sideask

See and answer `ask_user_question` prompts from other DSH sessions, without leaving the one you are in.

**Powered by [DSH](https://github.com/deepseek-ai/deepseek-harness)** — a plugin, not a fork.

## The problem

DSH renders an `ask_user_question` card only in the session that asked it. If you are working in session B while session A is blocked on a question, you cannot see it. Your choices are to switch sessions and hunt for it, or to leave the asking agent waiting.

## What this plugin does

- Collects pending questions from every session in the workspace.
- Shows a small **待答 N** counter in the sidebar footer. It is not rendered at all when nothing is pending.
- Opens a compact panel at the bottom-left corner when clicked: one card per session, showing the session title, the question, its options, and a free-text field.
- Submits the answer back to the asking session through `userQuestions.answer`.

The panel never takes over the composer, never steals focus, and never covers the center of the page.

## Requirements

- DSH `0.2.0` or later.
- **`ask_user_question` must run in `timed` mode.**

That last point matters. In the default `blocking` mode, a question stays in a foreground wait that only the card in the asking session can settle. This plugin cannot answer it — no external interface can. In `timed` mode the wait expires, the tool returns `pending`, and the question becomes *continued*: still answerable, but no longer owned by one interface. That is the state this plugin picks up.

Configure it on the `tool-ask-user` row of your profile's `cordis.patch.yml`:

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 60
```

With that in place, a question becomes answerable from this panel after `timeout` seconds. The tool also accepts a per-call `timeout` argument, so a caller that wants it faster can pass a smaller number.

## Install

1. Put the package under your profile's plugin directory, for example
   `~/.dsh/profiles/desktop/plugins/dsh-sideask`.
2. Link it into the profile's `node_modules/@local` under a name that matches the package name:

   ```powershell
   New-Item -ItemType Junction `
     -Path  "$HOME\.dsh\profiles\desktop\node_modules\@local\dsh-sideask" `
     -Target "$HOME\.dsh\profiles\desktop\plugins\dsh-sideask"
   ```

3. Add the row to `cordis.patch.yml`:

   ```yaml
   - id: dsh-sideask
     name: '@local/dsh-sideask'
   ```

4. Restart DSH. Client plugins are bundled at boot; reloading the page is not enough.

## How it works

Two halves.

**Host half** (`index.js`) listens to `session/event` globally and keeps a map of pending questions keyed by `sessionId|callId`.

- On `tool/call` named `ask_user_question`, it records the call with its questions and the session's working directory.
- On `tool/result`, it inspects the result: a `pending` reply means the timed wait expired and the question is still answerable, so the record is kept. Any other result means the question was settled, so the record is dropped.
- `turn/end` does not clear records; a continued question outlives the turn that asked it.

Two HTTP routes:

- `GET /dsh-sideask/list?session=<id>` returns the pending questions whose working directory matches the requesting session's, so one workspace stays separate from another.
- `POST /dsh-sideask/answer` with `{ sessionId, callId, answers }` forwards the answer via `ctx.userQuestions.answer(agent, callId, { answers })`.

**Client half** (`client.js`) registers two slots:

- `sidebar.footer.action` — the counter button, hidden when the count is zero.
- `shell.overlay` — the panel, positioned bottom-left, dismissed with × or Esc.

It polls the list route every 4 seconds while the counter is mounted, and refreshes on open.

## Gotchas worth knowing

- `userQuestions.answer` takes `{ answers: [...] }`, not a bare array. A bare array is rejected and returns `false`.
- `stillOpen === true` means the answer was accepted into the agent's queue. `false` means no matching continued question was found.
- A `pending` tool result is not an answer. Treating it as one makes questions disappear from the panel before anyone has answered them.
- After a successful submit, remove the item from the local cache immediately. Waiting for the server to drop it leaves a window where the panel still lists an answered question.

## Known limitations

- Only questions from the same working directory are shown.
- A question that is still inside its foreground wait cannot be answered from here; see Requirements.
- Records live in memory. A DSH restart clears them; questions that are still answerable will not be re-listed until they are asked again.
- Records older than 24 hours are dropped from the list.

## License

MIT
