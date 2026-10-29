# CLAUDE.md – Vaultfill Desktop

Unofficial Vaultwarden/Bitwarden client for macOS (Electron): menu-bar app, Spotlight-style quick search,
autotype, password check, agent access via MCP. Sibling repo: `vaultfill-extension` (Chrome).
This repository is **public**. Treat every commit, issue and log as world-readable.

## Commands

```bash
npm install
npm start                 # dev run
npm test                  # unit tests (must pass before every commit)
npm run pack              # dist/Vaultfill-darwin-arm64/Vaultfill.app (fuses + ad-hoc signature)
```

- E2E against a throwaway Vaultwarden in Docker, cross-checked with the official `bw` CLI: see the header of `test/vault.test.mjs`.
- App smoke test (real app, screenshots, MCP flow): see the header of `test/smoke.js`. Run it after changes to `main.js`, `mcp.cjs` or `ui/`.
- Releases: pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml` (sign, notarize, attach zip). Only the maintainer tags.

## Layout

| Path | Role |
|---|---|
| `main.js` | Main process: state, login/SSO, unlock, sync, quick search, autotype, health check, agent socket |
| `vault.js` | Protocol + crypto core. **Byte-identical copy in `vaultfill-extension`** |
| `lib/psl.js` | Generated Public Suffix List – do not edit by hand |
| `mcp.cjs` | MCP stdio server, runs with the system Node, holds no secrets except while running a confirmed command |
| `preload.cjs` | The only bridge to the renderer (`window.vf`) |
| `ui/` | Renderer pages (no Node, sandboxed) |
| `scripts/harden.cjs`, `build/` | Fuses, signing, notarization, entitlements |

## Security invariants – never weaken without an explicit maintainer decision

- **Secrets never leave memory unencrypted**: no passwords, keys, tokens or TOTP secrets in logs, errors, `console.*`, test output, commit messages, screenshots or issues.
- **Decrypted key and index live only in `mem`**; on disk only `state.bin` sealed with `safeStorage`. Lock (`lock()`) must clear everything derived from the key.
- **Renderer is untrusted**: `contextIsolation`, `sandbox`, no `nodeIntegration`, IPC sender check against the bundled `ui/` URL, CSP without inline/eval. No `innerHTML` with data – use `textContent`/`el()`.
- **Windows show only bundled UI**: navigation and `window.open` stay blocked (`lockDown`).
- **Agent access (MCP)**: opt-in per entry; per-session approval with Touch ID; every command that receives secrets is shown and confirmed; commands run in `mcp.cjs` (agent's permissions, never Vaultfill's); `list` returns metadata only; plaintext only for `reveal` shares with Touch ID per call. Agent-supplied strings are untrusted (sanitize before display).
- **Server is untrusted for parameters**: keep `checkKdf` (bounds + per-account pin), https-only except local hosts, URI matching via the Public Suffix List (https never on http, port = site).
- **Packaging**: fuses `RunAsNode`, `NODE_OPTIONS`, `--inspect` stay off; asar integrity stays on; sign after flipping fuses.
- **Autotype** goes through `osascript` stdin only (never argv), refuses control characters.

Any change touching these needs a test (unit, E2E or smoke) that would fail if the guarantee broke.

## Conventions

- **`vault.js` is shared**: change it in both repos in the same way and keep the files identical (`cmp`). Same for its unit tests.
- **Dependencies**: as few as possible, exact versions (`--save-exact`), no runtime dependencies besides the vendored `lib/`. Justify any new one in the commit message.
- **Crypto**: WebCrypto / Node crypto only. No hand-rolled primitives beyond the Bitwarden formats already in `vault.js`.
- **Code** and comments in English; **UI text** in German. Comments explain *why*, not what.
- **Commits**: Conventional Commits in English (`feat:`, `fix(security):`, `build:`, `docs:`, `test:`), one logical change per commit, body explains the reason.
- **Git**: never rewrite `main` or tags; no force pushes. Feature work on branches, merge via PR.

## Public-repo hygiene

- **Never commit**: `.p12`, `.p8`, `.cer`, `.pem` keys, `.env`, `state.bin`, keychain exports, Vaultwarden URLs/accounts of real people, personal paths (`/Users/<name>/…`), real e-mail addresses.
- **Test and screenshot data** is fictional only (`alice@example.com`, `Acme`, `example.com`). Screenshots come from `test/smoke.js` against a throwaway Vaultwarden – never from a real vault.
- **Signing**: only via CI secrets of the maintainer's own Developer ID. Never reference or use other signing identities found on a machine.
- **Security findings**: do not open public issues with exploit details; report privately to the maintainer.
- Before pushing, this must print nothing:
  `git grep -nIi -E "BEGIN (RSA |EC )?PRIVATE KEY|password=|/Users/" -- . ':!lib' ':!CLAUDE.md'`
