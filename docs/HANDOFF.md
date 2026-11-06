# Handoff: where the project stands and how to continue

For an agent or developer taking over `dsh-grok-acp` (repository GrokOnDeepSeekHarness).
Read [OVERVIEW.md](OVERVIEW.md) first (what it is), then this file (what to do next).
Machine-specific paths, accounts and credentials are deliberately not recorded here; the
repository is public.

## 1. State at handoff

- Package `dsh-grok-acp@0.4.0-dsh0.2.2-rc.1` for DeepSeek Harness (DSH) 0.2.2-rc.1.
  All `@deepseek-ai/dsh-*` peers are pinned to exactly `0.2.2-rc.1`.
- `main` is the release line. Work happens on short branches (`grok/<topic>`) merged by
  fast-forward after `npm run check` is green.
- `npm run check` = unit tests + `tsc` + `tsdown` build + bundle check. At handoff: 105 tests
  pass, 1 is skipped (a POSIX file-mode test that cannot run on Windows).
- Everything listed in [VERIFICATION.md](VERIFICATION.md) was run live on Windows 11 in a
  separate test profile. Everything listed in section 4 below was not.

## 2. Orientation (15 minutes)

1. [OVERVIEW.md](OVERVIEW.md): purpose, features, limits.
2. [ARCHITECTURE.md](ARCHITECTURE.md): files, one turn, resume, security model.
3. [REVIEW-2026-11-05.md](REVIEW-2026-11-05.md): independent review, what was fixed, what was
   deferred and why.
4. [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md): the only supported install procedure.
5. Code map: `lib/index.js` (entry and config), `lib/router.js` (DSH or Grok per blank
   session), `lib/grok-agent.js` (turn state machine that writes the DSH session log),
   `lib/acp-connection.js` (shared Grok child, ACP client, permissions, file access),
   `lib/grok-env.js` (child environment), `lib/workspace-path.js` (path checks),
   `src/client/` (browser side). Tests mirror modules in `tests/`.

## 3. Hard rules (do not relax without the owner's decision)

- Never read, copy or log `auth.json`, tokens or cookies. Never set `XAI_API_KEY`; sign-in is
  the Grok CLI's own OAuth login only.
- Install into DSH only with `dsh plugin add`. Never hand-edit a DSH profile. Test in a
  separate profile, never in the owner's `desktop` profile while the app is running.
- Keep peer pins exact. A new DSH release means a new build, not a version exemption.
- Grok state lives only in the configured `GROK_HOME`. The plugin must not write into
  cloud-synced folders.
- Spawn the Grok CLI without a shell, with an argument array, UTF-8, tolerant of spaces in
  paths. Keep `allowOutsideWorkspace` and `yoloMode` off. Permissions go to the DSH approval
  UI, one-shot only (never send `allow_always`).
- DSH mode stays the default and must not regress. The app must start without the Grok CLI.
- Ask the owner before anything destructive or outward-facing (force push, deleting repos,
  purging history, publishing to npm).
- The repository is public: no personal data, local paths, tokens or session ids in code,
  docs, commit messages or author fields (commits use the GitHub noreply address).

## 4. Not verified yet

- A real DeepSeek turn in DSH mode (the test profile had no DeepSeek credentials). Only the
  factory, presets and model catalog were exercised.
- Live runs of `forwardMcp: true` against a real MCP server, `steer` during a running turn, a
  pasted image, a failed harness switch, and the cloud-folder badge in the browser (unit
  tests only).
- macOS and Linux. The code has branches for them; nothing was run.
- The owner's real `desktop` profile. The install steps in INSTALL-FOR-AGENTS.md have only
  been exercised in a separate profile.

## 5. Backlog, in suggested order

1. Live-verify section 4 items in a test profile; record results in VERIFICATION.md.
2. Sandbox for Grok shell commands (research done, not implemented). The shared Grok process
   cannot be sandboxed per call. The feasible route is to advertise the ACP `terminal`
   client capability and serve `terminal/create` through DSH's `ctx.sandbox.confine`. First
   run a tiny test: does the Grok CLI actually call `terminal/create`? If not, the idea is
   dead.
3. Show Grok shell commands in a DSH terminal.
4. Child sessions in DSH for Grok's `/goal` and `/workflow`.
5. Hardening of the remote-access route (today loopback only).
6. A second ACP agent behind the same router (the router and `AcpHost` are the extension
   points).
7. Voice input.

## 6. How to work

```text
npm ci --legacy-peer-deps
npm test          # fast unit tests
npm run check     # tests + tsc + build + bundle check; must be green before any merge
```

- The test harness `tests/turn.spec.js` includes a `RuleSession` that mirrors the DSH 0.2.2
  session-log rules (advertised tool calls per step, step order). Any change in
  `lib/grok-agent.js` must keep it green; a violation shows up there before it breaks a live
  session.
- Read-only DSH 0.2.2-rc.1 sources (for API questions) come from the installed DSH app's
  `node_modules/@deepseek-ai`; the ACP SDK is `@agentclientprotocol/sdk` 0.25.1.
- Grok Build CLI 1.0.70 was the tested version. Ask it for capabilities at runtime rather
  than assuming them.
- Delegating to Grok Build works best for one narrow task per run with an explicit file list
  and "do not commit". Wide multi-task runs failed repeatedly. Review every diff yourself.
- After a change: `npm run check`, commit, fast-forward `main`, push. Rebuild the tarball and
  reinstall into the test profile to re-verify live.

## 7. Known traps

- The first run of a fresh DSH profile shows a sign-in onboarding step; it is bypassed in a
  test profile by a profile patch, not by hand edits of the real profile.
- DSH's default workspace sits in Documents. If Documents is redirected into a cloud folder,
  writes can be declined; set the workspace outside it.
- The "New session" button reuses a blank session, so the harness switch can look stuck.
- The DSH client slot names and Remote APIs are preview and can change between 0.2.x builds.
- A force-pushed or deleted fork can still leave commits reachable by SHA through the upstream
  repository; only GitHub Support can purge them.

## 8. Open decisions for the owner

- Whether to implement the sandbox work (backlog item 2) or leave it as documented.
- When to test in the real `desktop` profile.
- Whether to publish the package to npm, or keep it GitHub-only.
