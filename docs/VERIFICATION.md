# Verification log (2026-11-05)

Environment: Windows 11 Pro, Node v24.16.0, npm 11.13.0, DeepSeek Harness 0.2.2-rc.1 (app 44.7.0),
Grok Build CLI 1.0.70, pnpm 11.28.5 (bundled with DSH).

## Build and tests

| Command | Result |
|---|---|
| `npm ci --legacy-peer-deps` | 65 packages, clean |
| `npm run check` (tests, `tsc --noEmit`, `tsdown`, bundle check) | 40 tests pass, 0 fail, 1 skipped (POSIX file mode, Windows), typecheck clean, bundle requires only `@deepseek-ai/cordis`, `react`, `react/jsx-runtime` |
| `npm pack` | `dsh-grok-acp-0.4.0-dsh0.2.2-rc.1.tgz`, 24 files, about 47 kB |

`tests/turn.spec.js` replays Grok ACP updates through a mirror of the stored-log rules of DSH 0.2.x
(advertised tool calls, step and turn closing). It covers text-only turns, grouped routine tools,
edit steps with diffs, an edit queued behind running tools, a failed turn and live stream frames.

## ACP handshake (Grok CLI 1.0.70, GROK_HOME=home-ultra, no XAI_API_KEY)

`grok agent --no-leader stdio`: `initialize` (protocol 1, auth method `cached_token`), `authenticate`,
`session/new` (models `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`, efforts xhigh/high/medium/low),
`_x.ai/billing` (tier "SuperGrok Heavy"), `session/prompt` with a streamed answer and `end_turn`.
`@agentclientprotocol/sdk@0.25.1` was used.

## Installation into a separate profile

Profile `test` in an isolated `DSH_HOME`, created with
`dsh test --from-default-profile web --no-open --port 6300`, then
`dsh plugin --profile test add <tarball>`. The exact `0.2.2-rc.1` peers passed the DSH compatibility
check with no exemption and the bundle was appended to `dsh.profile.bundles`. The `desktop` profile
was not touched.

## Browser checks (built-in browser, http://127.0.0.1:6300)

- New chat shows the DSH / Grok Build switch. DSH is the default and shows `deepseek-flash`.
- Switching Grok, DSH and Grok again on a blank session works without a reload.
- In Grok mode the seat shows `Grok 4.7 · high`; the menu lists the four ACP models and four efforts.
- A Grok turn: answer streamed, `grok_build_activity` group ("Completed 1 operations · Read 1"), a write
  row `hello.txt +1 -0`, an approval prompt in the DSH UI, the file created in the test workspace.
- `/usage` prints "Plan: SuperGrok Heavy", credit usage and period (the Ultra profile).
- After a full DSH restart the stored history loads, the cold session keeps the Grok seat, and a
  follow-up message resumes the same Grok session (the answer used the earlier context).
- With `GROK_COMMAND` pointing to a missing file DSH starts, stays in DSH mode and the picker shows
  "Harness unavailable" with the reason in its tooltip.
- DSH preset menu lists Standard, PTC, Minimal and Creator; the Grok preset is hidden from it.

## Isolation

- Grok state: only under `GROK_HOME`; `~/.grok` had no new files.
- The session map is written to `<DSH_HOME>\grok-harness-sessions.json`.
- No new file appeared in the cloud-synced user folder (OneDrive) because of the run. One unrelated
  file written by the user on the desktop during the run was ignored.
- A first attempt used the DSH default workspace, which lives in OneDrive; the write was declined.
  The test profile was recreated with `documentsDirectory` pointing outside OneDrive.
- `auth.json` is never read or logged by the plugin; `XAI_API_KEY` is dropped from the child environment.

## Not verified

- A real DeepSeek turn in DSH mode (the test profile has no DeepSeek credentials and none were entered).
  The DSH factory, presets and model catalog were exercised; the turn itself was not.
- The existing `desktop` profile and its sessions: not touched on purpose.
- macOS and Linux.

## Re-verification after the review fixes (2026-11-05)

- `npm run check`: 69 tests pass, 0 fail, 1 skipped (POSIX file mode on Windows).
- Reinstalled into the `test` profile with `dsh plugin`; a Grok turn with a thought and a shell command
  completed in 8 s (2 steps); a file write showed an approval card containing the target path and was
  approved once; the turn completed.
- Typing `/always` shows no command: `/always-approve` is withheld.
