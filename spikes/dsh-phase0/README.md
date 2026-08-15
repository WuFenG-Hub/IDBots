# dsh-phase0 — DSH kernel migration spike

Phase 0 feasibility spike for replacing the Claude Agent SDK kernel with
DeepSeek Harness (DSH), consumed as npm packages (no forks). See
[PHASE0_REPORT.md](./PHASE0_REPORT.md) for findings and the route decision.

Layout:

- `cordis.yml` — minimal in-process composition (fake LLM, custom tools, JSONL persistence)
- `cordis.provider-pi-ai.yml` / `cordis.provider-deepseek.yml` — third-party endpoint routing tests
- `cordis.jsonrpc.yml` — composition with `dsh-sdk-jsonrpc-server` for subprocess mode
- `plugins/fake-llm.mjs` — scripted LLM adapter driving the whole loop without keys
- `plugins/idbots-wallet.mjs` — wallet-style cordis `Service` plugin (DX probe)
- `plugins/idbots-tools.mjs` — `defineTool` tools + `tools/pre-execute` permission gate
- `scripts/run-agent.mjs` — main driver (turns, tools, steer, cancel, resume)
- `scripts/provider-test.mjs` + `scripts/mock-openai.mjs` — endpoint-agnosticism tests
- `scripts/runtime-bin.mjs` — standalone SDK runtime bin (spawned by sdk-client)
- `scripts/sdk-client-test.mjs` — subprocess wire capability + gap probes

All `@deepseek-ai/*` deps are pinned to the `0.1.0-rc.6` line (npm `next`
tag): the `latest` dist-tags are stale and conflict (report §2, F1).
