# AGENTS.md

This repository is the **DSH / Grok Build bridge** for DeepSeek Harness 0.2.2-rc.1.

- To install it, follow [docs/INSTALL-FOR-AGENTS.md](docs/INSTALL-FOR-AGENTS.md) exactly.
- To understand it, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Never enter or print credentials, never read `auth.json`, never set `XAI_API_KEY`, never use a
  version exemption.
- Before changing code run `npm ci --legacy-peer-deps && npm run check`.
