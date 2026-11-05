# Upstream security audit (before forking)

Date: 2026-11-05. Scope: git checkout of `zmh2000829/DSH-agent-bridge` at commit
`e7111741a67269503d1f71c379902354687da7f8` (dsh-grok-acp 0.3.3) and the published npm
tarball `dsh-grok-acp@0.3.4`. Method: read-only review (grep, diff, file), nothing executed.

## Verdict: clean

No malicious indicators were found in either version.

## What was checked

- **Install-time scripts**: only `build`, `test`, `test:bundle`, `typecheck`, `check`, `prepack`.
  No `preinstall` / `install` / `postinstall` / `prepare`. Nothing runs on `npm install`.
- **Network**: server code imports no `http`/`https`/`net`/`dns`/`tls`, no `fetch`, no WebSocket.
  The client bundle performs exactly two `fetch` calls, both to the same-origin relative path
  `/grok-acp/session`. The only hosts in code are `127.0.0.1`/`localhost` used for parsing the
  Host header. Strings `_x.ai/billing`, `_x.ai/btw`, `_x.ai/session/info` are ACP JSON-RPC method
  names sent to the local Grok child process, not network endpoints.
- **Code execution**: no `eval`, `new Function`, `vm`, or dynamic import of remote specifiers.
  Child processes: the configured Grok command (`grok agent --no-leader stdio`) via DSH's
  `ctx.subprocess.spawn`, and `dsh` / `grok` from the `dsh-grok` helper CLI. Dynamic
  `import()` only of `@deepseek-ai/*` resolved from the DSH installation.
- **Obfuscation**: none. No base64/hex blobs, no `fromCharCode`/`atob`, no zero-width or bidi
  control characters. `lib/client.js` is unminified tsdown output containing only the project's
  own modules (no third-party libraries bundled).
- **Secrets**: `~/.grok/auth.json` is never read. Env vars read: `HOME`, `USER`, `PATH`, `LANG`,
  `GROK_COMMAND`, `DSH_HOME`, `DSH_COMMAND`, and `XAI_API_KEY` (forwarded to the child only if
  already set in the parent). No keychain, cookies, `localStorage`.
- **Writes**: `<DSH_HOME>/grok-harness-sessions.json` (atomic temp+rename, mode 0600) and ACP
  `fs/write_text_file` requests, which pass through `resolveWorkspacePath`.
- **Sandbox**: `lib/workspace-path.js` realpaths the workspace and the target (or nearest
  existing ancestor) and rejects anything outside, defeating `..`, absolute paths and symlinks.
  Escape is possible only when `allowOutsideWorkspace: true` or the DSH session itself is in
  `danger-full-access`.
- **HTTP route**: loopback-only Host check, `sec-fetch-site: cross-site` rejected, POST requires a
  matching `Origin` plus `content-type: application/json` and a 64 KB body cap. No CORS headers are
  emitted, so pages on other localhost ports cannot read responses.
- **package-lock.json**: 89 entries, all resolved from `registry.npmjs.org` with integrity hashes,
  no git/file/http deps, no `hasInstallScript`. Runtime deps: `@agentclientprotocol/sdk@0.25.1`,
  `@deepseek-ai/schemastery`, `@deepseek-ai/cosmokit`, `@standard-schema/spec`, `zod`.
- **CI**: `permissions: contents: read`, checkout + setup-node + `npm ci` + `npm run check` +
  `npm pack --dry-run`. No secrets, no publish.
- **Binaries**: only `docs/assets/*.png|gif` (verified image headers), excluded from the tarball.

## Notes carried into the fork

1. **Provenance gap (medium)**: the published 0.3.4 tarball has no matching commit or tag in the
   public repository (newest ref is `v0.3.3` = `e711174`). Its delta was reviewed line by line and
   contains only DSH 0.1.5-rc.3 compatibility work (new `dsh-compat.js`, `inbox.js`,
   `session-events.js`; assistant-stream frames; `reasoning_effort` config id; env/root ordering
   fix in `dsh.js`). The fork re-implements what it needs from that delta from source instead of
   copying the unreviewed tarball files.
2. **0.3.3 `lib/dsh.js` resolved DSH packages from `process.cwd()` first** (low): a planted
   `node_modules/@deepseek-ai/*` in the directory `dsh web` was started from would be preferred.
   The fork resolves from the running DSH installation first and the cwd last.
3. `bin/dsh-grok.mjs setup` installed `dsh-grok-acp@latest` (unpinned). The fork pins.
4. `XAI_API_KEY` forwarding is removed in the fork: only OAuth via the Grok CLI is used.
