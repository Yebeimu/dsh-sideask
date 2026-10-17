# dsh-sideask

See and answer `ask_user_question` prompts from other DSH sessions, without leaving the one you are in.

**Powered by [DSH](https://github.com/deepseek-ai/deepseek-harness)** — a plugin, not a fork.

[中文说明](README.zh.md)

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
