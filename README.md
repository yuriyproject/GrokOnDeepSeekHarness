# dsh-grok-acp (fork for DeepSeek Harness 0.2.2-rc.1)

Run **Grok Build** as the root agent of a DeepSeek Harness (DSH) Web session. A switch next to the
composer chooses **DSH** (the stock agent loop, the default) or **Grok Build**. In Grok mode the
Grok CLI drives the turn over the Agent Client Protocol (ACP). Its tool calls, file diffs and
permission requests are rendered by the native DSH UI and stored in the normal DSH session log.
No xAI API key is used: the bridge relies only on the OAuth login of the Grok Build CLI.

> **Origin.** This is a fork of [zmh2000829/DSH-agent-bridge](https://github.com/zmh2000829/DSH-agent-bridge)
> (MIT, commit `e7111741a67269503d1f71c379902354687da7f8`, behaviour reference `dsh-grok-acp@0.3.4`),
> ported to DSH `0.2.2-rc.1`. The original copyright notice is kept in [LICENSE](LICENSE).
> Русская версия: [README.ru.md](README.ru.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): what it is, how it works, why.
- [docs/INSTALL-FOR-AGENTS.md](docs/INSTALL-FOR-AGENTS.md): step-by-step install for an AI agent such as a DSH agent.
- [docs/REVIEW-2026-11-05.md](docs/REVIEW-2026-11-05.md): independent review, fixes and deferred items.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) and [docs/UPSTREAM-SECURITY-AUDIT.md](docs/UPSTREAM-SECURITY-AUDIT.md).

## Requirements

- DeepSeek Harness `0.2.2-rc.1` (desktop app 44.7.0 or the `dsh` CLI of the same release).
- Node.js `^22.19 || >=24` to build from source.
- Grok Build CLI (tested with 1.0.70) with a completed OAuth login (`grok login`).
- Windows 11, macOS and Linux are supported by the code; the verification below ran on Windows 11.

## Install

DSH accepts the bundle only when every `@deepseek-ai/dsh-*` peer dependency equals the running
release, so this package pins them to exactly `0.2.2-rc.1`. Never use a version exemption.

Install into a profile with the stock plugin command. **Do not edit profile files by hand.**
Quit the desktop app before touching the `desktop` profile, or better, try a separate profile first.

```powershell
git clone https://github.com/yuriyproject/DSH-agent-bridge.git
cd DSH-agent-bridge
git checkout dsh-0.2.2
npm ci --legacy-peer-deps
npm run check

# a separate profile named "test" (created from the web template on first boot)
$dsh = "C:\DS Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh test --from-default-profile web --no-open --port 6300   # Ctrl+C after it prints the URL
& $dsh plugin --profile test add (Get-Location).Path           # or a tarball from `npm pack`
```

Start it with the Grok environment (the values below are examples):

```powershell
$env:GROK_HOME    = "C:\DSProjects\grok\home-ultra"
$env:GROK_COMMAND = "C:\Users\you\.grok\bin\grok.exe"
Remove-Item Env:XAI_API_KEY -ErrorAction SilentlyContinue   # never needed
& $dsh test --no-open --port 6300
```

Open the printed URL, press **New session** and choose **Grok Build** below the composer. The
harness can change only while the session is blank.

To uninstall: `dsh plugin --profile test remove dsh-grok-acp`.

## Configuration

Set these in the environment that starts DSH. The bundle patch reads them.

| Variable | Meaning |
|---|---|
| `GROK_COMMAND` | Path of the Grok executable. Default: `~/.grok/bin/grok(.exe)`, then `grok` on `PATH`. |
| `GROK_HOME` | Grok state directory (auth, sessions, logs). Empty means Grok's own `~/.grok`. |
| `DSH_HOME` | DSH home. The session map `grok-harness-sessions.json` is stored there. |

Row options in `cordis.patch.yml` (`grok-acp`): `command`, `args`, `grokHome`, `env`, `stateFile`,
`disposeGraceMs`, `idleDisposeMs`, `yoloMode` (default `false`), `allowOutsideWorkspace`
(default `false`). `XAI_API_KEY` is dropped even when set in `env`.

## Differences from upstream

- **Versions:** all `@deepseek-ai/dsh-*` peers are exactly `0.2.2-rc.1`; `cordis` is `~4.1.0`,
  `schemastery` is `~3.19.0`. The upstream `dsh-agent-presets` and `dsh-invariants` packages do not
  exist in 0.2.2 and are no longer used.
- **Presets:** the Grok preset is a regular `@deepseek-ai/dsh-agent-preset` row (id `grok-build`)
  in the bundle patch and is read through `agentPresets` of `dsh-agent-preset-registry`. The
  harness switch calls `agentPresets.select()`; a registry fallback registers the preset when the
  YAML row is absent. The marker plugin still mounts the Grok slash commands.
- **Session log:** 0.2.2 validates stored logs strictly. Each Grok step now has an assistant
  message that advertises its tool calls. Routine tools form one `grok_build_activity` group
  (`tool/ptc-dispatch*` children). Every file edit is a root tool call in its own step, so DSH
  renders diff cards. `assistant/chunk` is gone; live text goes through `agent/assistant-stream`
  frames and each message stores its `stream` snapshot. Cancellations are recorded as `aborted`.
- **Agent contract:** the agent exposes `model` (`AgentModel`), uses its own durable inbox, takes
  its start from `turnBoundaryOf`, and is published through `agents.announce(agent, source)`.
- **Persistence:** resume and create use `sessionPersistence.open/create/read` instead of the
  removed `inspect/prepare`.
- **Client:** model seat and `/model` use `remote.session.modelCatalog/selectModel` and the
  `modelSelection` projection; command descriptions are thunks; `connection.api` and
  `handleHostEnvelope` are replaced by `ClientSessions.handleSessionAdded/Removed`; the preset
  seat reads the session through standard slot props; `dsh.client.inject` lists the 0.2.2 client
  modules. The `ptc` preset id is localized.
- **Isolation:** the Grok child keeps only an allow-list of environment variables (everything else
  inherited from DSH is removed with explicit tombstones), gets `GROK_HOME` from the config, never
  `XAI_API_KEY`, and starts with `shell: false`, an argument array, an absolute resolved executable
  and a neutral working directory. A missing
  CLI never stops DSH: the picker stays on DSH and shows the reason.
- **Permissions:** Grok permission requests go through the DSH approval service and show the
  command or path. A file write not covered by a permission asks too. `/always-approve` is withheld. `yoloMode` and
  `allowOutsideWorkspace` stay off; `danger-full-access` sessions still grant host-wide access.
- Removed the demo media and the Chinese README; the helper CLI `dsh-grok` is pinned to 0.2.2-rc.1.

## Security

An audit of the upstream repository and of `dsh-grok-acp@0.3.4` is in
[docs/UPSTREAM-SECURITY-AUDIT.md](docs/UPSTREAM-SECURITY-AUDIT.md): no install scripts, no network
code, no obfuscation, no secret access. The plugin never reads `auth.json`.

## Known limitations

- DSH 0.2.x is a preview: client slots and Remote APIs may change. Rebuild and re-run the real
  blank-session flow after a DSH upgrade. Exact peer pins mean the next DSH release needs a new
  build of this package.
- Routine tool calls are grouped under one activity row; their diffs appear inside the row text,
  not as diff cards. File edits get diff cards.
- Edits are shown one per step, and an edit waits until earlier routine calls finish.
- Grok text that arrives while a tool is running is shown after the tool settles.
- The DSH default workspace is `Documents\deepseek-harness\default-workspace`. With OneDrive
  folder redirection that is inside OneDrive. Choose a workspace outside it for Grok sessions.
- The Grok plan name comes from the CLI. An Ultra account reports as "SuperGrok Heavy".
- Two Windows unit tests are adjusted: POSIX file modes are skipped and the symlink test uses a
  junction.

## Development

```powershell
npm ci --legacy-peer-deps
npm run check      # tests, typecheck, build, bundle check
npm pack
```

Licensed under the [MIT License](LICENSE).
