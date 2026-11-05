# How the bridge works, and why

## What it is

`dsh-grok-acp` is a plugin bundle for **DeepSeek Harness (DSH)** 0.2.2-rc.1. It lets a DSH Web
session run on **Grok Build** (the xAI coding agent CLI) instead of the stock DSH agent loop. The
user chooses the engine with a **DSH / Grok Build** switch next to the composer. The chat UI, tool
rows, diff cards, approval prompts, history and `/` commands stay the native DSH ones.

It is a fork of [zmh2000829/DSH-agent-bridge](https://github.com/zmh2000829/DSH-agent-bridge) (MIT),
ported to DSH 0.2.2-rc.1.

## Why it exists

- Reuse a Grok subscription (OAuth login of the Grok CLI) inside the DSH interface without an xAI API key.
- Keep one UI and one session store for two agents, so sessions, approvals and diffs look the same.
- Keep the DSH agent unchanged: the switch is optional and DSH stays the default.

## Moving parts

```text
browser (DSH Web)                         DSH host process                       Grok CLI
 ├─ client bundle (lib/client.js)          ├─ index.js  (bundle entry)
 │   harness switch, Grok model seat,      │   swaps the agent-factory slot
 │   activity row, /model contribution     ├─ router.js  picks DSH or Grok per session
 │            │  GET/POST /grok-acp/session├─ grok-agent.js  Agent driven by ACP
 │            └──────────────────────────► ├─ web-route.js + http-route.js  loopback API
                                           ├─ acp-connection.js ── stdio JSON-RPC ──► grok agent --no-leader stdio
                                           └─ DSH services: agents, agentPresets, sessions,
                                              sessionPersistence, subprocess, approval, commands
```

| File | Role |
|---|---|
| `cordis.patch.yml` | Bundle patch: disables the stock model seat, declares the `grok-build` agent preset row, loads the bridge row. |
| `lib/index.js` | Plugin entry. Replaces the agent factory with the router, registers the preset if the YAML row is missing, mounts the `/grok-acp/session` route. |
| `lib/router.js` | Routes blank sessions to the DSH loop or to Grok. Reacts to `agent-preset/selected`, resumes a stored session with the right engine, falls back to DSH if Grok fails to start. |
| `lib/grok-agent.js` | The Grok agent: turn state machine, DSH log writing, durable inbox, commands. |
| `lib/acp-connection.js` | One shared Grok child process for all Grok sessions. ACP handshake, `session/new|resume|load`, permission and file requests, restart on exit, idle shutdown. |
| `lib/grok-env.js` | Finds the CLI and builds the minimal child environment. |
| `lib/workspace-path.js`, `lib/session-access.js` | File access limits for ACP file requests. |
| `lib/mapping.js` | Durable map DSH session id → Grok session id in `<DSH_HOME>/grok-harness-sessions.json`. |
| `src/client/*` | Browser side, built by `tsdown` into `lib/client.js`. |

## One Grok turn

1. The user sends a message. DSH wakes the Grok agent, which writes `turn/start` and `user/message`.
2. The agent sends `session/prompt` to Grok and receives `session/update` notifications.
3. Text and thoughts are published live as `agent/assistant-stream` frames and stored as a stream
   snapshot on the `assistant/message` of a **step**.
4. DSH 0.2.x validates stored logs: every tool call must be advertised by an assistant `tool-call`
   block of the same step, and a step may close only when its tools are resolved. The agent therefore
   keeps a small state machine:
   - Routine tools (read, search, command, other) form one **activity group**: an advertised
     `grok_build_activity` root call whose children are `tool/ptc-dispatch*` events.
   - A file edit is a **root tool call in its own step**, so DSH renders a diff card.
   - An edit waits until earlier group children finish. Text that arrives while an edit runs is held
     back and replayed after the step closes.
5. Grok permission requests call `approval.request()`, which opens the DSH approval prompt. The
   answer is mapped back to the ACP option. `danger-full-access` sessions auto-allow.
6. At the end the agent settles every open tool and step, then writes `turn/end`. A cancelled turn
   is recorded as `aborted`.

## Switching and resuming

- The switch is allowed only while the session is blank. It calls `agentPresets.select(agent, id)`;
  the router sees `agent-preset/selected` and swaps the underlying agent for the same session id.
- On restart DSH resumes a stored session through the router, which reads the selected preset from
  the stored log and resumes Grok through the saved id mapping (`session/resume`, then `session/load`).
- A started session whose agent is not live yet is shown by the browser as a read-only Grok session,
  using the `agentPreset` projection.

## Security model

- Loopback-only HTTP route, same-origin writes, JSON only, 64 KB body cap.
- The Grok child gets a minimal environment, `GROK_HOME` from the config, and **never** `XAI_API_KEY`.
  The plugin never reads `auth.json`. The process is started without a shell, with an argument array
  and a resolved absolute executable.
- ACP file requests stay inside the session workspace (symlinks included) unless the session has
  full access. `yoloMode` and `allowOutsideWorkspace` default to off.
- Upstream audit: [UPSTREAM-SECURITY-AUDIT.md](UPSTREAM-SECURITY-AUDIT.md).

## Limits and design choices

- One tool per step for edits and one group for routine tools is a consequence of the strict 0.2.x
  log rules, not a Grok limitation.
- Peer dependencies are exact pins; a new DSH release needs a rebuild.
- The DSH preview APIs used here (client slots, Remote namespaces, agent registry) may change.
