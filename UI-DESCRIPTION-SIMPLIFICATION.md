# UI Description Text Simplification - Executive Summary

## Problem

IDBots UI has too many verbose description texts (3-7+ lines) that create an overwhelming "AI-generated" feeling. Users don't like interfaces with walls of text.

**Example**: The "Desktop Operations" switch in MetaBot Advanced tab has 257 characters (7-8 lines) of description!

## Solution

**Hide long descriptions behind question mark icons (❔), keep only 1-2 line summaries inline.**

Pattern:
```
Before: [Label] + [5 lines of text below]
After:  [Label ❔] + [1 line or no text] + [Full text on hover]
```

## Critical Issues Found (Must Fix)

### MetaBot Edit Form - Advanced Tab
File: `src/renderer/components/metabots/MetaBotEditTabs.tsx`

1. **MCP Tools** (line 1309)
   - Current: 170 chars, 4-5 lines
   - Fix: Move to tooltip, keep 1 line or remove

2. **Browser Automation** (line 1334)
   - Current: 196 chars, 5-6 lines
   - Fix: Move to tooltip

3. **Desktop Computer Use** (line 1359)
   - Current: 257 chars, 7-8 lines
   - Fix: Move to tooltip

### Additional Areas

4. **Surf Section** - 386 chars (6-7 lines)
5. **Daily Report** - 112 chars (3 lines)  
6. **Memory Settings** - 8+ long hints (3-6 lines each)
7. **Group Tasks** - Review silence hint (3 lines)

**Total**: 30+ description strings need simplification

## Implementation Approach

### 1. Use Existing Tooltip Component
We already have `src/renderer/components/ui/Tooltip.tsx` - just wrap QuestionMarkCircleIcon:

```tsx
<label>
  {i18nService.t('metabotCoworkMcpTools')}
  <Tooltip content={i18nService.t('metabotCoworkMcpToolsTooltip')}>
    <QuestionMarkCircleIcon className="h-4 w-4 inline ml-1" />
  </Tooltip>
</label>
```

### 2. Update i18n Strings
For each long hint, create:
- `*HintShort`: Optional 1-2 line inline version
- `*Tooltip`: Full explanation (renamed from `*Hint`)

Example:
```typescript
// Old
metabotCoworkMcpToolsHint: '默认关闭：关闭时该 Bot 的 cowork 会话...(170 chars)',

// New
metabotCoworkMcpToolsHintShort: '默认关闭。启用后挂载 MCP 工具', // Optional inline
metabotCoworkMcpToolsTooltip: '默认关闭：关闭时该 Bot 的 cowork...(full)', // Hover
```

### 3. Rewrite Long Texts

**Desktop Computer Use** example:

Current (ZH, 257 chars):
> 默认开启：开启后该 Bot 的 cowork 会话可截屏并操作本机桌面（cua-driver）。需要给 IDBots 授予 macOS 辅助功能/录屏权限（首次使用系统会弹窗）。所有动作仅以后台方式执行：任何会移动你的物理鼠标或抢夺焦点的路由（前台投递、桌面作用域输入、拖拽、修饰键点击）都会被策略拒绝，其余改动性动作仍会在执行前征求你的批准。谨慎使用：模型对桌面的输入不可撤销...

Proposed (tooltip only, no inline):
> 默认开启。可截屏和控制桌面（需 macOS 权限）。所有操作后台执行，改动性动作需批准。谨慎使用：桌面输入不可撤销。工具仅挂载到该 Bot 会话。

## Files to Modify

1. **i18n**: `src/renderer/services/i18n.ts`
   - Add ~40 new strings (20 keys × 2 languages)

2. **Components** (~10 files):
   - `MetaBotEditTabs.tsx` - 3 capability switches
   - `SurfSection.tsx`
   - `DailyReportSection.tsx`
   - `MemorySettings.tsx` - 8 hints
   - `CapabilityDraftsPanel.tsx`
   - `DreamTelemetryPanel.tsx`
   - `MetaBotCreateForm.tsx`
   - Others (group tasks, etc.)

## Success Criteria

✅ No inline description exceeds 2 lines
✅ All 5+ line descriptions moved to tooltips  
✅ Consistent ❔ icon usage
✅ Both EN and ZH supported
✅ No information loss

## Estimation

- Phase 1: Reusable component (if needed): 1-2 hours
- Phase 2: i18n updates (~40 strings): 2-3 hours
- Phase 3: Component updates (~10 files): 4-5 hours
- Phase 4: Testing & QA: 1 hour

**Total**: 8-11 hours

## Detailed Documents

Full analysis available in:
- `localdocs/ui-description-simplification-plan.md` (7.6 KB)
- `localdocs/ui-description-audit-details.md` (11.5 KB)

These documents contain:
- Complete audit table of all 30+ strings
- Specific text rewrites with before/after
- Component code examples
- Comprehensive checklist

---

**Next Steps**: 
1. Review and approve this plan
2. Proceed with Phase 1-4 implementation
3. Visual QA in both light/dark themes
4. Test on various screen sizes
