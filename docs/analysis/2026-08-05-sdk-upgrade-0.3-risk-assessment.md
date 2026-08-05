# Option B Risk Assessment: `@anthropic-ai/claude-agent-sdk` 0.2.12 → 0.3.221

Date: 2026-08-05 · Status: Assessment only · Companion to `2026-08-05-cowork-kernel-openclaw-evaluation.md`

Verified against the actual published package (`npm pack @anthropic-ai/claude-agent-sdk@0.3.221`, Claude Code `2.1.221`, built 2026-08-03) diffed against our installed 0.2.12 (Claude Code `2.1.12`).

## 1. Verdict

**Not a version bump — a packaging-architecture change.** Moderate, localized code effort (~3–5 dev-days for the port itself) but a **wide test matrix** and two structural impacts (app size +~260 MB, VM image +~270 MB). Recommended approach: pilot branch, keep 0.2.12 in `main` until the matrix passes.

Risk level: **Medium-High** overall; highest sub-risk is provider behavior drift (CLI 2.1.12 → 2.1.221 is ~200 Claude Code releases), not the SDK API itself.

## 2. What changed in the SDK package

| Aspect | 0.2.12 (ours) | 0.3.221 |
|---|---|---|
| CLI distribution | `cli.js` — 11 MB minified Node script bundled in the package | **Native compiled binary per platform** (`claude` / `claude.exe`), ~270–290 MB, delivered via optionalDependencies `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-{x64,arm64}` (incl. linux musl variants); `manifest.json` with checksums |
| Spawn | SDK spawns `node cli.js` (hence our Electron-as-node patch) | SDK detects non-JS executable and **spawns the binary directly**; JS-entry path retained for `.js/.mjs` entries |
| peerDependencies | `zod ^4` only | **adds `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`** (neither is a direct dep of IDBots today) |
| New exports | — | session-management API (`listSessions`, `getSessionMessages`, `forkSession`, `renameSession`, `deleteSession`, `SessionStore`…), warm-query API, many new control requests |
| Removed exports | `unstable_v2_prompt`, `unstable_v2_createSession`, `unstable_v2_resumeSession` | **gone** |
| Event union | baseline | large additive expansion (`SDKActiveGoalMessage`, task/notification/hook/elicitation/rate-limit messages, new `system` subtypes `post_turn_summary`, `session_state_changed`, …) |

**Core APIs we depend on are intact** (verified in new `sdk.d.ts` / `sdk.mjs`): `query()` with `string | AsyncIterable<SDKUserMessage>` prompt (steer channel OK), `options.canUseTool`, `options.agents: Record<string, AgentDefinition>`, `options.systemPrompt` (now `string | string[] | object`), `options.resume`, `options.includePartialMessages`, `options.mcpServers`, `tool()`, `createSdkMcpServer()`, `pathToClaudeCodeExecutable` (still honored; native-binary resolution added with automatic musl detection — relevant to our Alpine VM).

## 3. Impact on our three patch layers

| Patch | Status after upgrade | Action |
|---|---|---|
| `patches/@anthropic-ai+claude-agent-sdk+0.2.12.patch` (patch-package: swap `node`/`bun` for Electron path in `spawnLocalProcess`) | **Obsolete + won't apply** (ProcessTransport rewritten). Also **unnecessary**: the native binary is spawned directly, no `node` involved | Delete; re-verify packaged-mode spawn (binary must live outside asar → update `electron-builder.json:124-128` asarUnpack globs to include the platform packages) |
| `scripts/patch-claude-sdk-cli.js` #1 (cygpath fallback for Git-Bash Windows) | **Dead** — `cli.js` no longer exists; compiled binary cannot be string-patched | Re-test Windows/Git-Bash paths on the new binary; if the bug persists, fix via env/cwd handling on our side or pin behavior in tests |
| `scripts/patch-claude-sdk-cli.js` #2 (Explore agent `model:"haiku"` → `"inherit"`) | **Dead** | Already covered by our `options.agents` Explore override (`coworkRunner.ts:253-283`) which still exists in the new SDK — verify the override wins over the built-in definition |

Net effect: the upgrade *removes* our need for the Electron-as-node machinery (`IDBOTS_ELECTRON_PATH`, `ELECTRON_RUN_AS_NODE` for the CLI child, Windows node-shim in `coworkUtil.ts` can be reviewed for removal).

## 4. Code changes required (localized)

1. `claudeSettings.ts` `getClaudeCodePath()` — resolve the platform binary instead of `cli.js` (SDK ships a resolver; or `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>/claude')`).
2. `coworkUtil.ts:1153-1202` `generateSessionTitle` — `unstable_v2_prompt` is removed; replace with a one-shot `query()` (or new session API). Small rewrite.
3. Root + `sandbox/agent-runner` package.json — bump pin to `0.3.221`, add peer deps (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`; zod already present).
4. `electron-builder.json` — asarUnpack globs for the new platform packages; packaging size budget.
5. Delete/retire the two patch layers above; `postinstall` script simplification.
6. Sandbox VM: `sandbox/agent-runner` picks up the **linux-x64-musl** binary automatically (Alpine = musl; SDK has explicit musl detection) — but `sandbox/image/build.sh` image size grows by ~280 MB, and the CDN-delivered image + `coworkSandboxRuntime.ts` download sizes need re-publishing.

## 5. Structural impacts

- **App size**: unpacked region grows ~11 MB → ~270–290 MB (one platform binary per build). Measured compressibility of the darwin-arm64 binary (270,518,240 B raw): gzip (≈ macOS DMG zlib) = **74 MB**, xz -6 (≈ Windows NSIS LZMA2 / AppImage) = **47 MB**. Realistic installer growth: **macOS ~+70 MB, Windows/Linux ~+45–50 MB**; installed on-disk footprint grows ~+250 MB. This is user-visible (download/disk) and needs release sign-off.
- **VM image**: +~270 MB raw (musl binary; ~50–75 MB if distributed compressed) — affects CDN cost, first-run download time (`cowork:sandbox:downloadProgress` flow), and image-build scripts.
- **Node engines**: still `>=18` (no OpenClaw-style Node 24 requirement) — no Electron constraint change.

## 6. Functional risk areas (test matrix)

| Risk | Why | Severity | Mitigation |
|---|---|---|---|
| Provider behavior drift | CLI jumps 2.1.12 → 2.1.221 (~200 releases). Its internal Anthropic-API client may send new request shapes/betas through our `coworkOpenAICompatProxy` to DeepSeek/Ollama/OpenAI-compat providers | **High** — IDBots users rely heavily on non-Anthropic providers | Matrix-test each configured provider through the proxy; extend `coworkProviderErrors`/format transforms as needed |
| Session resume | Claude Code session storage format may have changed; existing users' `claudeSessionId` could fail to resume | Medium | Existing stale-resume retry (`coworkRunner.ts:4600-4615`) degrades gracefully to a fresh session; verify UX acceptable |
| Error-string heuristics | Our retries match on strings ("No conversation found", context overflow, DeepSeek `reasoning_content`) — CLI error surfaces changed across 200 releases | Medium | Audit `handleClaudeEvent` result-error branches against new CLI outputs; new SDK exports `USAGE_LIMIT_ERROR_PREFIXES` etc. as a hint of changed surfaces |
| Windows/Git-Bash paths | cygpath patch dies; native binary path handling unverified on Windows | Medium | Full Windows pass: local mode, sandbox serial mode, Git-Bash shell |
| Permission / steer / MCP flows | Additive protocol changes; `canUseTool` control-channel dedup logic changed (request_id dedup noted in d.ts) | Low-Med | Regression-run the ~30 cowork test suites + manual permission/steer checks |
| Sandbox guest SDK | agent-runner inside Alpine must install the musl platform package via `npm ci --omit=dev` | Low-Med | Rebuild image in `scripts/build-sandbox-image-*.sh`; verify `agentd` boot + binary spawn |

## 7. Effort estimate

| Workstream | Estimate |
|---|---|
| Port code (items §4) | 3–5 dev-days |
| Patch retirement + packaging rework (asarUnpack, size checks, installer smoke) | 2–3 dev-days |
| VM image rebuild + CDN publish + sandbox regression | 2–3 dev-days |
| Provider matrix testing (Anthropic direct + proxy providers, incl. error/retry paths) | 3–5 dev-days |
| Full platform regression (macOS/Windows local + sandbox) | 3–5 dev-days |
| **Total** | **~2.5–4 weeks** of focused effort, dominated by testing |

## 8. Recommendation

1. Pilot in a throwaway branch off `main` (not the analysis worktree): port + run the cowork test suites.
2. Gate on: (a) provider matrix green, (b) packaged-app spawn on all 3 OSes, (c) sandbox image rebuilt and smoke-tested, (d) installer-size sign-off.
3. Ship behind normal release process; keep 0.2.12 hot-fixable in parallel until one release cycle of field stability.
4. This keeps Option C on track: the SDK upgrade buys time and parity, while the OpenClaw dual-engine pilot proceeds independently.
