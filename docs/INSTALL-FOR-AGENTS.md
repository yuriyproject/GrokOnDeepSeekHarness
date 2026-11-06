# Install guide for an AI agent (DeepSeek Harness agent)

Goal: add the **DSH / Grok Build** switch to a DeepSeek Harness 0.2.2-rc.1 installation.
Follow the steps in order. Stop and report if any check fails. Do not work around a failure.

## Hard rules

- Install only through `dsh plugin add`. Never edit `package.json`, `cordis.yml` or `cordis.patch.yml`
  of a profile by hand to add the bundle.
- Never enter, copy, print or log credentials. Never read `auth.json`. Never set `XAI_API_KEY`.
- Never grant a version exemption (`dsh plugin allow-version`). A peer mismatch means this build does
  not match the installed DSH: stop.
- Do not touch the `desktop` profile while the DSH app is running. Use a separate profile first.
- Keep Grok state in a dedicated `GROK_HOME`. Choose workspaces outside cloud-synced folders.

## 1. Check prerequisites

```bash
dsh --version          # must print 0.2.2-rc.1
node --version         # ^22.19 or >=24
grok --version         # Grok Build CLI, tested with 1.0.70
```

The Grok CLI must already be signed in (`grok login`). The sign-in is a user action.

## 2. Get and build the package

```bash
git clone https://github.com/yuriyproject/GrokOnDeepSeekHarness.git
cd GrokOnDeepSeekHarness
git checkout dsh-0.2.2
npm ci --legacy-peer-deps
npm run check          # all steps must pass
npm pack               # produces dsh-grok-acp-<version>.tgz
```

## 3. Install into a separate profile

```bash
dsh <profile> --from-default-profile web --no-open --port 6300   # creates the profile; stop it (Ctrl+C) after the URL is printed
dsh plugin --profile <profile> add ./dsh-grok-acp-<version>.tgz   # absolute path is safest
dsh plugin --profile <profile> list                               # must list dsh-grok-acp
```

If `add` reports an incompatible version, stop.

## 4. Run

Set the environment in the shell that starts DSH:

```bash
export GROK_HOME=/path/to/grok-home          # Windows PowerShell: $env:GROK_HOME = "C:\path\grok-home"
export GROK_COMMAND=/path/to/grok            # optional; defaults to ~/.grok/bin/grok
dsh <profile> --no-open --port 6300
```

Open the printed URL (it contains a one-time token; do not share it).

## 5. Verify

1. Start a new session. A **DSH / Grok Build** switch appears under the composer, DSH selected.
2. Select **Grok Build**. The seat shows a Grok model such as `Grok 4.7 · high`.
3. Ask for a harmless action in a scratch workspace. An approval prompt must appear in the DSH UI.
4. Type `/usage`. It prints the Grok plan and usage.
5. If the Grok CLI is missing, DSH must still start and the switch must show "Harness unavailable".

## Uninstall

```bash
dsh plugin --profile <profile> remove dsh-grok-acp
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "incompatible with dsh" at `add` | Installed DSH is not 0.2.2-rc.1. Use a build made for that release. |
| Switch missing | Browser console shows client load errors; the plugin's `dsh.client.inject` modules must match the DSH release. |
| "Grok Build CLI is not available" | Set `GROK_COMMAND` to the real executable; check `grok --version`. |
| Grok asks to sign in | Run `grok login` for the same `GROK_HOME`. |
| Composer blocked, "Model selection is unavailable" | The session is a DSH session without a DeepSeek login, or the DSH model catalog failed. Sign in to DSH yourself or choose Grok Build. |

More detail: [ARCHITECTURE.md](ARCHITECTURE.md), [VERIFICATION.md](VERIFICATION.md).
