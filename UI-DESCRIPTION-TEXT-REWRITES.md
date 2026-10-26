# UI Text Simplification - Exact String Rewrites

## Quick Reference for i18n Updates

This document contains the exact before/after text for all string changes. Copy-paste ready for implementation.

---

## 🔴 Phase 1: MetaBot Advanced Tab (Critical)

### 1. MCP Tools

#### Chinese

**Old** (can remove):
```javascript
metabotCoworkMcpToolsHint: '默认关闭：关闭时该 Bot 的 cowork 会话不挂载你在设置中配置的 MCP server，每轮请求不再携带 MCP 工具 schema（首请求更小、token 费用更低）。仅对确实需要 MCP 工具的 Bot 开启，切换立即生效。注意：DSH 会话共享同一运行时，任一 Bot 挂载后所有 DSH 会话都会看到这些工具，直至应用重启。',
```

**New** (option 1 - no inline hint):
```javascript
metabotCoworkMcpToolsTooltip: '默认关闭。开启后将你配置的 MCP 工具挂载到该 Bot 的 cowork 会话中。未启用时首次请求更小、token 费用更低。注意：DSH 会话共享运行时，一旦挂载，所有 DSH 会话可见直至重启。',
```

**New** (option 2 - with short inline hint):
```javascript
metabotCoworkMcpToolsHintShort: '默认关闭。启用后在 cowork 会话中挂载 MCP 工具',
metabotCoworkMcpToolsTooltip: '默认关闭。开启后将你配置的 MCP 工具挂载到该 Bot 的 cowork 会话中。未启用时首次请求更小、token 费用更低。注意：DSH 会话共享运行时，一旦挂载，所有 DSH 会话可见直至重启。',
```

#### English

**Old**:
```javascript
metabotCoworkMcpToolsHint: 'Off by default: while off, this bot\'s cowork sessions do not mount your configured MCP servers, so MCP tool schemas stay out of every request (smaller first request, lower token cost). Enable only for bots that actually need MCP tools; applies immediately. Note: DSH sessions share one runtime — once any bot mounts MCP tools, they remain visible to all DSH sessions until the app restarts.',
```

**New** (option 1):
```javascript
metabotCoworkMcpToolsTooltip: 'Off by default. Mount MCP tools in this bot\'s cowork sessions. When disabled, requests are smaller and cost less. Note: DSH sessions share runtime—tools become visible to all once mounted.',
```

**New** (option 2):
```javascript
metabotCoworkMcpToolsHintShort: 'Off by default. Mount MCP tools in cowork',
metabotCoworkMcpToolsTooltip: 'Off by default. Mount MCP tools in this bot\'s cowork sessions. When disabled, requests are smaller and cost less. Note: DSH sessions share runtime—tools become visible to all once mounted.',
```

---

### 2. Browser Automation

#### Chinese

**Old**:
```javascript
metabotCoworkBrowserAutomationHint: '默认开启：开启后该 Bot 的 cowork 会话会通过 Playwright MCP 操作一个独立的 headless Chromium（每个会话一个浏览器），可导航/点击/填表/截图任意公开网站。Bot Browser（链上内容）不受其影响也不可被其读取。浏览器工具只会挂载到该 Bot 的会话（开启的 Bot 运行在独立的运行时上，不会泄漏给其他 Bot）；显式关闭后下一轮对话即生效。',
```

**New** (option 1):
```javascript
metabotCoworkBrowserAutomationTooltip: '默认开启。使用 Playwright 自动化浏览器，可导航网站、截图、填表。每个会话独立浏览器，不影响 Bot Browser。工具仅挂载到该 Bot 会话。',
```

**New** (option 2):
```javascript
metabotCoworkBrowserAutomationHintShort: '默认开启。使用 Playwright 自动化浏览器',
metabotCoworkBrowserAutomationTooltip: '默认开启。使用 Playwright 自动化浏览器，可导航网站、截图、填表。每个会话独立浏览器，不影响 Bot Browser。工具仅挂载到该 Bot 会话。',
```

#### English

**Old**:
```javascript
metabotCoworkBrowserAutomationHint: 'On by default: each DSH session gets its own headless Chromium via Playwright MCP and can navigate, click, fill forms, and screenshot ordinary public websites. The Bot Browser (on-chain content) is unaffected and stays invisible to external automation. Browser tools mount only for this bot\'s sessions — each bot\'s sessions run on a dedicated runtime, so the tools never leak to other bots — and an explicit opt-out applies from the next turn.',
```

**New** (option 1):
```javascript
metabotCoworkBrowserAutomationTooltip: 'On by default. Automate browser via Playwright—navigate, click, screenshot public sites. Each session gets its own headless Chromium. Bot Browser (on-chain) unaffected. Tools never leak to other bots.',
```

**New** (option 2):
```javascript
metabotCoworkBrowserAutomationHintShort: 'On by default. Automate browser via Playwright',
metabotCoworkBrowserAutomationTooltip: 'On by default. Automate browser via Playwright—navigate, click, screenshot public sites. Each session gets its own headless Chromium. Bot Browser (on-chain) unaffected. Tools never leak to other bots.',
```

---

### 3. Desktop Computer Use

#### Chinese

**Old**:
```javascript
metabotCoworkComputerUseHint: '默认开启：开启后该 Bot 的 cowork 会话可截屏并操作本机桌面（cua-driver）。需要给 IDBots 授予 macOS 辅助功能/录屏权限（首次使用系统会弹窗）。所有动作仅以后台方式执行：任何会移动你的物理鼠标或抢夺焦点的路由（前台投递、桌面作用域输入、拖拽、修饰键点击）都会被策略拒绝，其余改动性动作仍会在执行前征求你的批准。谨慎使用：模型对桌面的输入不可撤销。桌面操作工具只会挂载到该 Bot 的会话（开启的 Bot 运行在独立的运行时上，不会泄漏给其他 Bot）；显式关闭后下一轮对话即生效。',
```

**New** (option 1 - recommended, no inline):
```javascript
metabotCoworkComputerUseTooltip: '默认开启。可截屏和控制桌面（需 macOS 权限）。所有操作后台执行，改动性动作需批准。谨慎使用：桌面输入不可撤销。工具仅挂载到该 Bot 会话。',
```

**New** (option 2):
```javascript
metabotCoworkComputerUseHintShort: '默认开启。可截屏和控制桌面，需 macOS 权限',
metabotCoworkComputerUseTooltip: '默认开启。可截屏和控制桌面（需 macOS 权限）。所有操作后台执行，改动性动作需批准。谨慎使用：桌面输入不可撤销。工具仅挂载到该 Bot 会话。',
```

#### English

**Old**:
```javascript
metabotCoworkComputerUseHint: 'On by default. When on, this bot\'s cowork sessions can screenshot and operate this desktop (cua-driver). IDBots needs the macOS Accessibility/Screen Recording grants (the OS prompts on first use). Actions run in background mode only: anything that would move your physical mouse pointer or steal focus (foreground delivery, desktop-scope input, drag, modifier clicks) is refused by policy, and every other mutating action still asks for your approval first. Use with care: input delivered to the desktop cannot be rolled back. Desktop-control tools mount only for this bot\'s sessions — each bot\'s sessions run on a dedicated runtime, so the tools never leak to other bots — and an explicit opt-out applies from the next turn.',
```

**New** (option 1):
```javascript
metabotCoworkComputerUseTooltip: 'On by default. Screenshot and control desktop via cua-driver. Requires macOS permissions. Background mode only—no mouse stealing. Mutating actions need approval. Use carefully: desktop input is irreversible. Tools never leak to other bots.',
```

**New** (option 2):
```javascript
metabotCoworkComputerUseHintShort: 'On by default. Control desktop with macOS permissions',
metabotCoworkComputerUseTooltip: 'On by default. Screenshot and control desktop via cua-driver. Requires macOS permissions. Background mode only—no mouse stealing. Mutating actions need approval. Use carefully: desktop input is irreversible. Tools never leak to other bots.',
```

---

## 🟡 Phase 2: Other MetaBot Features

### 4. Surf Section

#### Chinese

**Current**:
```javascript
surfSectionHint: '默认开启。开启后，Bot 会在每晚做梦前自动冲浪 AI 互联网：学习网络上的新内容、以它的人格参与互动（点赞/评论/回答）、处理收到的通知，并生成一份可读的冲浪报告。关闭后 Bot 跳过 AI 互联网交互，仅梦到自己的工作和记忆。切换在下一次梦境周期生效。',
```

**New**:
```javascript
surfSectionHintShort: '默认开启。Bot 在做梦前自动冲浪 AI 互联网',
surfSectionTooltip: '开启后在每晚做梦前自动冲浪：学习新内容、参与互动、处理通知，生成冲浪报告。关闭后仅梦到自己的工作和记忆。下次梦境周期生效。',
```

#### English

**Current**:
```javascript
surfSectionHint: 'On by default. When enabled, the bot automatically surfs the AI internet before each nightly dream: learns new content, engages (like/comment/answer) with its persona, handles notifications, and generates a readable surf report. When disabled, the bot skips AI internet interaction and only dreams about its own work and memories. Toggle takes effect on the next dream cycle.',
```

**New**:
```javascript
surfSectionHintShort: 'On by default. Bot surfs AI internet before dreams',
surfSectionTooltip: 'When enabled, the bot automatically surfs before each dream: learns content, engages with its persona, handles notifications, generates report. When off, dreams only about own work and memories. Takes effect on next dream cycle.',
```

---

### 5. Daily Report

#### Chinese

**Current**:
```javascript
dailyReportSectionHint: '开启后，Twin Bot 会在每天你选定的本地时间主动发起一个新会话，汇报待你跟进的事项、你交代工作的进展以及 Bot 集群动态，并附带可点击的会话链接。若电脑关机则跳过当天汇报。',
```

**New**:
```javascript
dailyReportSectionHintShort: 'Twin Bot 每天定时主动汇报待办和工作进展',
dailyReportSectionTooltip: '开启后，Twin Bot 会在每天选定时间主动发起新会话，汇报待办事项、工作进展、Bot 动态，附带可点击链接。电脑关机则跳过。',
```

#### English

**Current**:
```javascript
dailyReportSectionHint: 'When enabled, the Twin Bot proactively starts a new session at your chosen local time each day, reporting pending items, progress on delegated work, and bot-cluster dynamics, with clickable session links. If the computer is off, that day\'s report is skipped.',
```

**New**:
```javascript
dailyReportSectionHintShort: 'Twin Bot reports daily at scheduled time',
dailyReportSectionTooltip: 'When enabled, Twin Bot starts a new session daily at your chosen time, reporting pending items, work progress, and bot-cluster updates with clickable links. Skipped if computer is off.',
```

---

## 🟢 Phase 3: Memory Settings (Examples)

### 6. Context Window Size

#### English

**Current**:
```javascript
contextWindowSizeHint: 'Leave empty to inherit the built-in catalog (unknown models get a conservative 128k default). Set an integer to pin: "200000" means the model reads up to 200k tokens and is allowed to output a proportional share (usually 1/3 to 1/5 of the window). Measured in tokens, NOT characters: a character may encode as 1–4 tokens depending on language and encoding.',
```

**New**:
```javascript
contextWindowSizeHintShort: 'Leave empty to inherit built-in catalog',
contextWindowSizeTooltip: 'Leave empty to inherit the built-in catalog (unknown models default to 128k). Set integer to pin: "200000" means model reads up to 200k tokens. Measured in tokens, not characters (1 character = 1-4 tokens).',
```

---

### 7. Memory Culture

#### English

**Current**:
```javascript
memoryCultureHint: 'The fleet-wide shared coordination baseline: glossary, conventions and team lessons learned, seeded from your initial AGENTS.md / CLAUDE.md. Agents inherit this as context. Updated gradually through manual edits and (when experimental memory hygiene is on) periodic dream-driven refinement that distills redundancies, clarifies ambiguity, and aligns with actual practice.',
```

**New**:
```javascript
memoryCultureTooltip: 'Fleet-wide shared baseline: glossary, conventions, and lessons learned. Seeded from AGENTS.md/CLAUDE.md. Agents inherit as context. Updated via manual edits or dream-driven refinement.',
```

---

## Implementation Notes

### Recommended Approach

For **Phase 1 (Critical)**, recommend **Option 1** (no inline hint):
- Cleanest UI
- Biggest impact
- Information still available on hover

For **Phase 2+ (Medium/Low priority)**, use **Option 2** (with short hint) if:
- Feature is less familiar to users
- One-line hint provides useful context
- Otherwise use Option 1

### Template for New Strings

```javascript
// Chinese
zh: {
  // Option 1: No inline hint
  [key]Tooltip: '简短的完整说明...',
  
  // Option 2: With short inline hint
  [key]HintShort: '1 行简短提示',
  [key]Tooltip: '简短的完整说明...',
}

// English
en: {
  [key]Tooltip: 'Concise full explanation...',
  
  [key]HintShort: '1 line short hint',
  [key]Tooltip: 'Concise full explanation...',
}
```

### String Length Guidelines

- **HintShort**: Max 40-60 chars in English, 20-30 chars in Chinese (1 line)
- **Tooltip**: Max 200-300 chars (4-5 short sentences, clear and scannable)

---

## Full String List (For Reference)

Total: ~54 strings across all phases

### Phase 1 (Critical - 6 strings)
- [x] metabotCoworkMcpToolsHint/Tooltip/HintShort (ZH+EN)
- [x] metabotCoworkBrowserAutomationHint/Tooltip/HintShort (ZH+EN)
- [x] metabotCoworkComputerUseHint/Tooltip/HintShort (ZH+EN)

### Phase 2 (MetaBot - 10 strings)
- [ ] surfSectionHint/Tooltip/HintShort (ZH+EN)
- [ ] dailyReportSectionHint/Tooltip/HintShort (ZH+EN)
- [ ] metabotArchetypeHint → Tooltip (ZH+EN)
- [ ] knowledgeBasePanelHint → Tooltip (ZH+EN)
- [ ] metawebStudyPanelHint → Tooltip (ZH+EN)

### Phase 3 (Memory - 24 strings)
- [ ] contextWindowSizeHint → Tooltip/HintShort
- [ ] coworkApiConfigHint → Tooltip
- [ ] coworkMemoryLlmJudgeEnabledHint → Tooltip
- [ ] coworkMemoryVisibilityExternalSafeHint → Tooltip
- [ ] memoryPolicyMaxItemsHint → Tooltip
- [ ] memoryHygieneDeepHint → Tooltip
- [ ] memoryCultureHint → Tooltip
- [ ] memoryCultureCommTrendHint → Tooltip
- [ ] memoryPracticeBotToggleHint → Tooltip
- [ ] memoryPracticeAutoApproveToggleHint → Tooltip
- [ ] memorySelfIdentityHint → Tooltip
- [ ] coworkMemoryEmbeddingDownloadHint → Tooltip
(All above × 2 languages = 24)

### Phase 4 (Dream & Capabilities - 6 strings)
- [ ] dreamTelemetryFailuresHint → Tooltip (ZH+EN)
- [ ] dreamTelemetryDiaryTrustHint → Tooltip (ZH+EN)
- [ ] capabilityDraftsHint → Tooltip (ZH+EN)

### Phase 5 (Group Tasks & Misc - 8 strings)
- [ ] groupTasksReviewSilenceHint → Tooltip (ZH+EN)
- [ ] workspaceInstructionsHint → Tooltip (ZH+EN)
- [ ] githubImportDescription → Tooltip (ZH+EN)
- [ ] missingSkillsBannerDescription → Tooltip (ZH+EN)

**Total**: 54 strings (27 keys × 2 languages)

---

**Created**: 2024-10-27  
**Branch**: `worktree-ui-description-simplify`  
**Status**: Ready for implementation
