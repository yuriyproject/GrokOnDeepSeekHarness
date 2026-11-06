[Русский](OVERVIEW.ru.md) · [README](../README.md)

# GrokOnDeepSeekHarness

`dsh-grok-acp` (package `0.4.0-dsh0.2.2-rc.1`) is a plugin for DeepSeek Harness (DSH) 0.2.2-rc.1 Web. It runs Grok Build as the root agent of a DSH session, in the DSH chat UI.

## The problem

DSH Web already stores the session and draws tool rows, diffs, approval prompts and `/` commands. Grok Build is a separate coding-agent CLI: it signs in with OAuth and speaks the Agent Client Protocol (ACP). The bridge runs that CLI behind the DSH interface so a Grok login can be used without an xAI API key. The stock DSH agent stays available and remains the default.

## What you get

- A **DSH / Grok Build** switch next to the composer. DSH is selected by default. The switch is allowed only while the session is blank. If the Grok CLI is missing, DSH still starts. The switch shows "Harness unavailable", and the reason is in its tooltip.
- Native DSH tool rows. Routine tools share one `grok_build_activity` group (`tool/ptc-dispatch*` children); diffs inside that group are text. Each file edit is its own step and renders as a diff card.
- Approval prompts in the DSH UI. The card shows the command or the path, redacted and shortened. A file write that no permission covered also asks.
- Model and effort for that Grok session only. Grok Build CLI 1.0.70 advertised `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6` and `grok-4.5`, and efforts `xhigh`, `high`, `medium` and `low`. Another session does not change the first.
- Slash commands on a Grok session: `/usage` and `/cost`, `/model` and `/models`, `/effort`, `/grok-model`, `/context`, `/compact`, `/session-info` (also `/status` and `/info`), `/btw`, `/deep-research`, `/workflow` and `/goal`. `/always-approve` is withheld.
- Resume after a DSH restart, from the stored log and the map `grok-harness-sessions.json` under `DSH_HOME`. The Grok session id is also stored as an ignorable record in the DSH log, and that record is used only when the map has no entry.
- Image attachments. The log stores a reference, not the bytes. The agent reads the DSH attachment store and sends ACP image content when the CLI advertises image prompts; otherwise it sends a named placeholder.
- A warning badge when the workspace path is inside a cloud-sync folder (OneDrive, Dropbox and similar). The check is `isCloudSyncedPath` in `lib/cloud-path.js`.
- Optional MCP forwarding. `forwardMcp` in `cordis.patch.yml` defaults to `false`. Set to `true`, active host `dsh-mcp-client` rows are sent to Grok. Preset-scoped servers and a stdio `cwd` are not forwarded. Secret values are redacted in logs.

`steer` aborts the running turn (reason `user`) and starts the next turn with the new text. ACP cannot insert text into a prompt that is already running.

## How it works

The browser keeps the DSH Web client. The bundle patch disables the stock model seat, declares the `grok-build` preset and replaces the agent factory with a router. On a blank session the router keeps the official DSH loop or starts the Grok agent. That agent drives one shared Grok child over ACP (`grok agent --no-leader stdio`) and writes the normal DSH session log. The client uses the loopback route `/grok-acp/session` for the switch, the Grok model seat and the cloud-folder flag.

```text
browser (DSH Web)                 DSH host                         Grok CLI
  switch, model seat, tool rows     router: DSH loop or Grok
  approvals and / commands          grok-agent writes the DSH log
        |                           /grok-acp/session (loopback)
        +-------- same-origin HTTP --------+
                                    acp-connection, stdio JSON-RPC
                                              |
                                              +-- grok agent --no-leader stdio
```

## Safety and privacy

There is no xAI API key. `XAI_API_KEY` is dropped in any letter case, including a value set in the row `env`. Sign-in is only the OAuth login of the Grok Build CLI (`grok login`). The plugin does not read `auth.json`.

The child receives an allow-list of environment variables. Every other parent variable is set to `undefined` in the overlay, which is how DSH removes it. `GROK_HOME` comes from configuration. The process starts with `shell: false`, an argument array, a resolved absolute executable and the system temp directory as its working directory. The session workspace is passed explicitly.

ACP file access stays inside that workspace. The check covers symlinks, Windows trailing-dot segments, device names and streams. Reads and writes stop at 8 MiB. `yoloMode` and `allowOutsideWorkspace` are `false` in the bundle patch. A DSH session on `danger-full-access` still has host-wide file access and skips prompts. An approval answer is one-shot (`allowed-once`, `rejected`, `cancelled` or `unavailable`). The bridge does not send `allow_always` or `reject_always`.

The HTTP route requires loopback on both socket ends, checks Host and Origin, accepts JSON only and caps the body at 64 KB. The client calls that route on the same origin.

A read-only audit of upstream commit `e7111741a67269503d1f71c379902354687da7f8` and of npm package `dsh-grok-acp@0.3.4` found no install scripts, no network client, no obfuscation and no reading of `auth.json`. This fork drops the `XAI_API_KEY` forwarding that package still had. An independent review on 2026-11-05 ([REVIEW-2026-11-05.md](REVIEW-2026-11-05.md)) fixed the child environment, Windows path checks, unapproved writes, cancel and unload hangs, the idle shutdown, a silent empty resume, loopback checks, and the 8 MiB file cap. What remains: no sandbox wrapper around the Grok process, and Full access is still a whole-session DSH mode.

## Requirements and quick start

- DeepSeek Harness `0.2.2-rc.1` (desktop app 44.7.0, or the `dsh` CLI of that release).
- Node.js `^22.19` or `>=24`, to build from source.
- Grok Build CLI, already signed in with `grok login`. The checks in this repository used CLI 1.0.70.
- The code includes Windows, macOS and Linux paths. The verification log is Windows 11 only.

The full procedure, hard rules and troubleshooting are in [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md). Six-line start:

```text
npm ci --legacy-peer-deps
npm run check
dsh <profile> --from-default-profile web --no-open --port 6300
dsh plugin --profile <profile> add <path-or-tarball>
# set GROK_HOME and, if needed, GROK_COMMAND; do not set XAI_API_KEY
dsh <profile> --no-open --port 6300
```

Open the printed URL (it contains a one-time token; do not share it), start a new session and choose Grok Build. Install only with `dsh plugin add`. Leave the `desktop` profile alone while the DSH app is running.

## Status and limitations

- DSH 0.2.x is a preview. Client slots and Remote APIs may change between releases.
- Every `@deepseek-ai/dsh-*` peer is pinned to `0.2.2-rc.1`. The next DSH release needs a new build of this package. A version exemption is the wrong fix.
- Verification was recorded on Windows 11 (DSH 0.2.2-rc.1, Grok Build CLI 1.0.70). macOS and Linux were not run.
- A real DeepSeek turn in DSH mode was not run. The test profile had no DeepSeek credentials. The DSH factory, presets and model catalog were exercised.
- Covered by unit tests only, not by a live run: `forwardMcp: true` against a real MCP server, `steer` during a running turn, a pasted image, a failed harness switch, and the cloud-folder badge in the browser.
- A file edit waits until earlier routine calls finish, then takes its own step. Text that arrives while a tool runs is shown after the tool settles.
- If Grok cannot resume or load its session, the host sets `contextLost` and prefixes the next prompt with stored user and assistant text, newest first, capped at 20,000 characters.
- The DSH default workspace is `Documents\deepseek-harness\default-workspace`. When Documents is redirected into a cloud folder, choose a workspace outside it.
- The plan name comes from the CLI. In the verification log an Ultra account reported "SuperGrok Heavy".
- Not in this build: a sandbox wrapper for the Grok process, a DSH terminal for Grok shell tools, and child sessions for `/goal` and `/workflow`.

## Origin and credits

Fork of [zmh2000829/DSH-agent-bridge](https://github.com/zmh2000829/DSH-agent-bridge) (MIT, commit `e7111741a67269503d1f71c379902354687da7f8`). The behaviour reference was the published package `dsh-grok-acp@0.3.4`. This tree ports that bridge to DSH 0.2.2-rc.1: exact peer pins, a normal `@deepseek-ai/dsh-agent-preset` row (`grok-build`), a session log that satisfies the 0.2.2 rules, and tighter process and file limits. The upstream copyright notice stays in [LICENSE](../LICENSE). This package is MIT.

## Where to read next

- [README.md](../README.md) and [README.ru.md](../README.ru.md) — install sketch and the upstream diff.
- [ARCHITECTURE.md](ARCHITECTURE.md) — files, one turn, resume and the security model.
- [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) — install steps for an agent.
- [REVIEW-2026-11-05.md](REVIEW-2026-11-05.md) — findings, fixes and deferred items.
- [VERIFICATION.md](VERIFICATION.md) — what was run, and what was not.
- [UPSTREAM-SECURITY-AUDIT.md](UPSTREAM-SECURITY-AUDIT.md) — audit of the upstream tree and of `dsh-grok-acp@0.3.4`.
