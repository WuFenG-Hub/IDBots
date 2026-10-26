# UI Description Simplification - Visual Comparison

## Current State (Problem)

```
┌───────────────────────────────────────────────────────────────────────┐
│ Advanced                                                                │
│                                                                         │
│ 🔧 Cowork Capabilities                                                 │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ MCP Tools                                              ●───○    │   │
│ │                                                                  │   │
│ │ 默认关闭：关闭时该 Bot 的 cowork 会话不挂载你在设置中配置     │   │
│ │ 的 MCP server，每轮请求不再携带 MCP 工具 schema（首请         │   │
│ │ 求更小、token 费用更低）。仅对确实需要 MCP 工具的 Bot 开      │   │
│ │ 启，切换立即生效。注意：DSH 会话共享同一运行时，任一 Bot      │   │
│ │ 挂载后所有 DSH 会话都会看到这些工具，直至应用重启。            │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ Browser Automation (Experimental)                      ○───●    │   │
│ │                                                                  │   │
│ │ 默认开启：开启后该 Bot 的 cowork 会话会通过 Playwright MCP    │   │
│ │ 操作一个独立的 headless Chromium（每个会话一个浏览器），可     │   │
│ │ 导航/点击/填表/截图任意公开网站。Bot Browser（链上内容）不     │   │
│ │ 受其影响也不可被其读取。浏览器工具只会挂载到该 Bot 的会话     │   │
│ │ （开启的 Bot 运行在独立的运行时上，不会泄漏给其他 Bot）；      │   │
│ │ 显式关闭后下一轮对话即生效。                                   │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ Desktop Operations (Experimental)                      ○───●    │   │
│ │                                                                  │   │
│ │ 默认开启：开启后该 Bot 的 cowork 会话可截屏并操作本机桌面     │   │
│ │ （cua-driver）。需要给 IDBots 授予 macOS 辅助功能/录屏权      │   │
│ │ 限（首次使用系统会弹窗）。所有动作仅以后台方式执行：任何会     │   │
│ │ 移动你的物理鼠标或抢夺焦点的路由（前台投递、桌面作用域输入     │   │
│ │ 、拖拽、修饰键点击）都会被策略拒绝，其余改动性动作仍会在       │   │
│ │ 执行前征求你的批准。谨慎使用：模型对桌面的输入不可撤销。       │   │
│ │ 桌面操作工具只会挂载到该 Bot 的会话（开启的 Bot 运行在独      │   │
│ │ 立的运行时上，不会泄漏给其他 Bot）；显式关闭后下一轮对话      │   │
│ │ 即生效。                                                         │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘

❌ Problems:
   - 19 lines of description text for 3 simple toggles
   - Users feel overwhelmed, don't read it
   - Looks like generated AI content
   - Takes up too much vertical space
```

## Proposed Solution

```
┌───────────────────────────────────────────────────────────────────────┐
│ Advanced                                                                │
│                                                                         │
│ 🔧 Cowork Capabilities                                                 │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ MCP Tools  ❔                                          ●───○    │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ Browser Automation (Experimental)  ❔                  ○───●    │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ Desktop Operations (Experimental)  ❔                  ○───●    │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘

✅ Benefits:
   - 3 lines instead of 19 lines (84% reduction!)
   - Clean, professional appearance
   - Information still available on hover
   - Users can explore if interested
```

## Tooltip Interaction (Hover on ❔)

```
┌─────────────────────────────────────────────────────────────────┐
│ Desktop Operations (Experimental)  ❔ <--[HOVER]      ○───●    │
└─────────────────────────────────────────────────────────────────┘
                     ↓
            ┌──────────────────────────────────────┐
            │ 默认开启。可截屏和控制桌面（需       │
            │ macOS 权限）。所有操作后台执行，     │
            │ 改动性动作需批准。谨慎使用：桌面     │
            │ 输入不可撤销。工具仅挂载到该 Bot    │
            │ 会话。                               │
            └──────────────────────────────────────┘
```

## Alternative: Option with Short Inline Hint

For less critical features, we can keep a very short inline hint:

```
┌─────────────────────────────────────────────────────────────────────┐
│ MCP Tools  ❔                                          ●───○        │
│ 默认关闭。启用后挂载 MCP 工具                                      │
└─────────────────────────────────────────────────────────────────────┘
     ↓ (hover on ❔)
   ┌────────────────────────────────────────────────────────┐
   │ 默认关闭：关闭时该 Bot 的 cowork 会话不挂载你在       │
   │ 设置中配置的 MCP server，每轮请求不再携带 MCP        │
   │ 工具 schema（首请求更小、token 费用更低）。仅对       │
   │ 确实需要 MCP 工具的 Bot 开启，切换立即生效。          │
   │ 注意：DSH 会话共享同一运行时，任一 Bot 挂载后         │
   │ 所有 DSH 会话都会看到这些工具，直至应用重启。         │
   └────────────────────────────────────────────────────────┘
```

## Space Savings Calculation

### MetaBot Advanced Tab (Cowork Capabilities Section)

**Before**:
- MCP Tools: 5 lines of description
- Browser Automation: 6 lines
- Desktop Operations: 8 lines
- **Total: 19 lines of text**

**After (no inline hints)**:
- All 3: 0 lines of description
- **Total: 0 lines**
- **Savings: 19 lines (100%)**

**After (with short inline hints)**:
- All 3: 1 line each
- **Total: 3 lines**
- **Savings: 16 lines (84%)**

### Full UI Impact (Conservative Estimate)

Assuming we fix the 10 critical areas (5+ lines each):

**Before**: ~50 lines of description text
**After**: ~10 lines (short hints) or 0 lines (tooltip only)
**Savings**: 40-50 lines across the entire app

## User Experience Flow

1. **First-time user**: Sees clean labels with ❔ icons
   - "What does this do?" → Hovers on ❔
   - Reads explanation in tooltip
   - Makes informed decision

2. **Experienced user**: 
   - Already knows what the toggle does
   - Doesn't need to scan past 5 lines of text
   - Can quickly toggle and move on

3. **Power user**:
   - Tooltips still there if memory fails
   - Clean interface doesn't feel condescending
   - Professional appearance builds trust

## Design Consistency

The ❔ icon pattern is already used elsewhere in the codebase:

```tsx
// Example from MetaBotEditTabs.tsx line 884
<span className="relative inline-flex shrink-0 group">
  <button
    type="button"
    className="rounded-full p-0.5 dark:text-claude-darkTextSecondary"
    aria-label={i18nService.t('metabotPrimaryLlmHint')}
  >
    <QuestionMarkCircleIcon className="h-4 w-4" />
  </button>
  <span role="tooltip" className="pointer-events-none absolute ...">
    {i18nService.t('metabotPrimaryLlmHint')}
  </span>
</span>
```

We're just applying this pattern consistently everywhere long text appears.

## Technical Implementation

### Before (Current Code)
```tsx
<div className={rowClass}>
  <label>{i18nService.t('metabotCoworkComputerUse')}</label>
  <div>
    <Toggle />
    <p className={hintClass}>
      {i18nService.t('metabotCoworkComputerUseHint')} {/* 257 chars! */}
    </p>
  </div>
</div>
```

### After (Proposed Code)
```tsx
<div className={rowClass}>
  <label>
    {i18nService.t('metabotCoworkComputerUse')}
    <Tooltip content={i18nService.t('metabotCoworkComputerUseTooltip')}>
      <QuestionMarkCircleIcon className="h-4 w-4 inline ml-1.5 
        text-secondary hover:text-accent transition-colors" />
    </Tooltip>
  </label>
  <div>
    <Toggle />
    {/* No inline hint, or optionally: */}
    {/* <p className={hintClass}>
      {i18nService.t('metabotCoworkComputerUseHintShort')}
    </p> */}
  </div>
</div>
```

## Similar Patterns in Other Apps

This approach is common in professional UIs:

- **GitHub Settings**: "❔" next to advanced options
- **VS Code Settings**: Gear icon with tooltip for detailed explanations
- **Figma**: "i" icon next to complex features
- **Linear**: Minimal inline text, rich tooltips on hover

We're following industry best practices for progressive disclosure.
