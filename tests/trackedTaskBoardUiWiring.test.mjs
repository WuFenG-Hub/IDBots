import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Static wiring tests for the tracked-task board UI fixes (owner 2026-09-18).
 *
 * The dev-instance E2E pass is noisy (vite HMR full-reloads), so the wiring
 * contracts these fixes introduced are locked here at source level, following
 * the repo's *Static.test.mjs pattern. Each assertion names the exact file and
 * the load-bearing token; refactorings that break the wiring fail loudly.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

const drawerSrc = read('src', 'renderer', 'components', 'trackedTasks', 'TrackedTaskDrawer.tsx');
const linkSrc = read('src', 'renderer', 'components', 'trackedTasks', 'MetaWebUriLink.tsx');
const modalSrc = read('src', 'renderer', 'components', 'trackedTasks', 'AdmissionRulesModal.tsx');
const sectionSrc = read('src', 'renderer', 'components', 'trackedTasks', 'TrackedTasksSection.tsx');
const appSrc = read('src', 'renderer', 'App.tsx');
const composerSrc = read('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const serviceSrc = read('src', 'renderer', 'services', 'trackedTask.ts');
const preloadSrc = read('src', 'main', 'preload.ts');
const mainSrc = read('src', 'main', 'main.ts');
const boardSrc = read('src', 'main', 'services', 'trackedTaskBoard.ts');
const typesSrc = read('src', 'renderer', 'types', 'trackedTask.ts');
const dtsSrc = read('src', 'renderer', 'types', 'electron.d.ts');
const i18nSrc = read('src', 'renderer', 'services', 'i18n.ts');

test('drawer: the fixed overlay root carries non-draggable so the header drag strip cannot swallow clicks', () => {
  // The root node of the drawer (fixed inset-0 z-50) must be non-draggable:
  // ScheduledTasksView's 48px header is draggable and window-global drag
  // regions ignore DOM stacking, so the top-right X was unclickable.
  const root = drawerSrc.match(/<div className="([^"]*fixed inset-0 z-50[^"]*)">/);
  assert.ok(root, 'drawer fixed root found');
  assert.match(root[1], /(?:^|\s)non-draggable(?:\s|$)/, 'drawer root must carry non-draggable');
});

test('drawer: the scroll body carries min-h-0 (flex column min-height:auto trap)', () => {
  assert.match(
    drawerSrc,
    /className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"/,
    'drawer body must be min-h-0 flex-1 overflow-y-auto',
  );
});

test('drawer: goal text preserves newlines and clamps to 6 lines with a measured expand/collapse', () => {
  assert.match(drawerSrc, /whitespace-pre-wrap/, 'goal copy must keep original line breaks');
  assert.match(drawerSrc, /WebkitLineClamp: GOAL_COLLAPSED_LINES/, 'collapsed state uses line clamp');
  assert.match(drawerSrc, /GOAL_COLLAPSED_LINES = 6/, 'default truncation is ~6 lines');
  assert.match(
    drawerSrc,
    /scrollHeight > el\.clientHeight \+ 1/,
    'expand/collapse visibility is measured via ref overflow, not a char heuristic',
  );
  // The measured value gates the button; expanding keeps the button visible.
  assert.match(drawerSrc, /\(expanded \|\| collapsedOverflow\)/);
  assert.match(drawerSrc, /'trackedTask\.drawer\.expand'/);
  assert.match(drawerSrc, /'trackedTask\.drawer\.collapse'/);
  // A card switch must reset the expansion state (keyed remount).
  assert.match(drawerSrc, /<ExpandableGoal key=\{detail\.id\}/);
});

test('MetaWebUriLink: only MetaWeb schemes linkify, bare pinIds become pin:// URIs, clicks ride botBrowser:openUri', () => {
  assert.match(
    linkSrc,
    /\(?:pin\|metaapp\|metafile\|metaid\):\/\//,
    'the scheme allowlist is exactly pin:// metaapp:// metafile:// metaid://',
  );
  assert.match(linkSrc, /\[0-9a-f\]\{64\}i0/, 'bare pinId pattern (64 hex + i0) is recognised');
  assert.match(linkSrc, /`pin:\/\/\$\{token\}`/, 'a bare pinId is turned into pin://<pinId>');
  assert.match(
    linkSrc,
    /botBrowser:openUri/,
    'clicks dispatch the existing botBrowser:openUri channel',
  );
  assert.match(linkSrc, /newTab: true/, 'link clicks open a NEW browser tab');
  assert.match(linkSrc, /text-claude-accent/, 'links are accent-coloured');
  // Non-MetaWeb strings stay plain text: there is no http(s) branch.
  assert.doesNotMatch(linkSrc, /https?(?::|\\?\/)/, 'no http(s) linkification');
});

test('drawer: deliverables and the closure pinId render through MetaWebUriLink', () => {
  assert.match(drawerSrc, /<MetaWebUriLink text=\{item\.uri\} \/>/, 'deliverable uris are links');
  assert.match(drawerSrc, /<MetaWebUriLink text=\{detail\.closure\.pinId\} \/>/, 'closure pinId is a link');
});

test('toolbar: admission entry sits left of refresh, refresh left of the new-task button', () => {
  const admIdx = sectionSrc.indexOf("i18nService.t('trackedTask.admission.entry')");
  const refreshIdx = sectionSrc.indexOf('type="button"\n        onClick={() => void trackedTaskService.loadBoard()}');
  const newIdx = sectionSrc.indexOf("i18nService.t('trackedTask.newTask.button')");
  assert.ok(admIdx > -1, 'admission entry button exists');
  assert.ok(refreshIdx > -1, 'refresh button exists');
  assert.ok(newIdx > -1, 'new-task button exists');
  assert.ok(admIdx < refreshIdx && refreshIdx < newIdx, 'toolbar order: admission < refresh < new task');
  // The admission button takes over the right-alignment (ml-auto); the refresh
  // button lost it when the cluster grew.
  const admBlock = sectionSrc.slice(admIdx - 600, admIdx);
  assert.match(admBlock, /ml-auto/, 'admission entry carries ml-auto');
  assert.match(sectionSrc, /QuestionMarkCircleIcon/, 'admission entry uses the question-mark icon');
  assert.match(
    sectionSrc,
    /className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"/,
    'new-task button matches the scheduled-tasks New Task styling exactly',
  );
  assert.match(
    sectionSrc,
    /new CustomEvent\('cowork:newChatWithDraft', \{\s*detail: \{ text: i18nService\.t\('trackedTask\.newTaskDraft'\) \},?\s*\}\)/,
    'the new-task button dispatches cowork:newChatWithDraft with the i18n draft text',
  );
});

test('admission modal: non-draggable root, existing admission keys plus the two new lines', () => {
  const root = modalSrc.match(/<div className="([^"]*fixed inset-0 z-\[9999\][^"]*)"/);
  assert.ok(root, 'modal fixed root found');
  assert.match(root[1], /(?:^|\s)non-draggable(?:\s|$)/, 'modal root must carry non-draggable');
  for (const key of [
    'trackedTask.admission.title',
    'trackedTask.admission.hint',
    'trackedTask.admission.activeRules',
    'trackedTask.admission.archiveNote',
    'trackedTask.admission.modeSwitchNote',
  ]) {
    assert.match(modalSrc, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `modal reuses ${key}`);
  }
  // adm1..adm5 resolve through the shared label-key table (single key source).
  assert.match(
    modalSrc,
    /TRACKED_ADMISSION_RULE_LABEL_KEYS\[rule\]/,
    'modal renders ADM-1..ADM-5 via the shared label-key table',
  );
});

test('drawer: the archive entry only appears for closed, still-admitted cards', () => {
  assert.match(
    drawerSrc,
    /detail\.state === 'closed' && detail\.admitted && onArchiveCard/,
    'archive button is gated on closed + admitted (archive view stays read-only)',
  );
  assert.match(drawerSrc, /'trackedTask\.archive\.action'/);
  assert.match(drawerSrc, /'trackedTask\.archive\.archiving'/);
});

test('archive write path: renderer service -> preload -> d.ts -> main IPC -> kv single-row override', () => {
  assert.match(
    serviceSrc,
    /async archiveCard\(input: \{ cardId: string; archived: boolean \}\)/,
    'renderer service exposes archiveCard',
  );
  assert.match(serviceSrc, /api\.archiveCard\(/, 'service calls the bridge');
  assert.match(serviceSrc, /void this\.loadBoard\(\)/, 'service refetches the whole board after archiving');

  assert.match(preloadSrc, /archiveCard: \(input: \{ cardId: string; archived: boolean \}\) =>/, 'preload bridge');
  assert.match(preloadSrc, /ipcRenderer\.invoke\('trackedTask:archiveCard', input\)/, 'preload channel');

  assert.match(dtsSrc, /TrackedCardArchiveResult/, 'd.ts mirrors the result type');
  assert.match(dtsSrc, /archiveCard: \(input: \{ cardId: string; archived: boolean \}\) => Promise<TrackedCardArchiveResult>/);

  assert.match(mainSrc, /ipcMain\.handle\('trackedTask:archiveCard'/, 'main registers the IPC handler');
  assert.match(mainSrc, /broadcastTrackedTaskUpdate\(\[input\.cardId\], 'archived'\)/, 'main broadcasts the update');

  // Main service: ONE kv row, no DDL, reversible, projection shift only.
  assert.match(boardSrc, /TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY = 'tracked_card_archive_override'/);
  assert.match(boardSrc, /admitted = admissionVerdict\.admitted && !overrideArchived/, 'admitted := admitted AND NOT override');
  assert.match(boardSrc, /archived: false/, 'archived:false is a first-class input (reversible)');
  assert.match(boardSrc, /parseArchiveOverrides/);
  // The counts contract still partitions every card into exactly one bucket.
  assert.match(boardSrc, /admittedCards\.length/, 'admitted count from the partition');
  assert.match(boardSrc, /archivedCards\.length/, 'archived count from the partition');

  assert.match(typesSrc, /export interface TrackedCardArchiveResult/, 'renderer type mirror exists');
});

test('App.tsx: cowork:newChatWithDraft routes the draft text through focus-input after the clear logic', () => {
  assert.match(
    appSrc,
    /window\.addEventListener\('cowork:newChatWithDraft', handler\)/,
    'App listens for the new-chat-with-draft event',
  );
  assert.match(
    appSrc,
    /handleNewChat\(undefined, text\)/,
    'the handler forwards the text as the draft',
  );
  assert.match(
    appSrc,
    /detail: \{ clear: shouldClearInput, text: draftText \}/,
    'focus-input detail carries the draft text',
  );
  // Order: the event is dispatched from the setTimeout AFTER clearSession/clearSelection.
  const clearIdx = appSrc.indexOf('coworkService.clearSession()');
  const dispatchIdx = appSrc.indexOf("'cowork:focus-input'");
  assert.ok(clearIdx > -1 && dispatchIdx > clearIdx, 'draft text is applied after the clear logic');
});

test('CoworkPromptInput: focus-input applies detail.text via the versioned draft field, then focuses', () => {
  assert.match(
    composerSrc,
    /const text = \(event as CustomEvent<\{ text\?: unknown \}>\)\.detail\?\.text;/,
    'handleFocusInput reads detail.text',
  );
  assert.match(
    composerSrc,
    /draftFieldRef\.current\?\.set\(text\)/,
    'the draft is written through the versioned field (lands in setDraftPrompt)',
  );
  const setIdx = composerSrc.indexOf('draftFieldRef.current?.set(text)');
  const focusIdx = composerSrc.indexOf('textareaRef.current?.focus();', setIdx);
  assert.ok(focusIdx > setIdx, 'the text is applied before the focus call inside the same rAF');
  assert.match(
    composerSrc,
    /textarea\.setSelectionRange\(end, end\)/,
    'the caret lands at the end of the prefilled draft',
  );
});

test('i18n: every new key exists in BOTH dictionaries', () => {
  const zhStart = i18nSrc.indexOf('  zh: {');
  const enStart = i18nSrc.indexOf('  en: {');
  const zhBlock = i18nSrc.slice(zhStart, enStart);
  const enBlock = i18nSrc.slice(enStart);
  const newKeys = [
    'trackedTask.admission.entry',
    'trackedTask.admission.archiveNote',
    'trackedTask.admission.modeSwitchNote',
    'trackedTask.newTask.button',
    'trackedTask.newTaskDraft',
    'trackedTask.archive.action',
    'trackedTask.archive.archiving',
    'trackedTask.archive.successToast',
    'trackedTask.drawer.expand',
    'trackedTask.drawer.collapse',
  ];
  for (const key of newKeys) {
    assert.match(zhBlock, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `zh missing ${key}`);
    assert.match(enBlock, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `en missing ${key}`);
  }
  // The en draft is the equivalent sentence, not a copy of the zh text.
  const enDraftLine = enBlock.split('\n').find((line) => line.includes("'trackedTask.newTaskDraft'"));
  assert.ok(enDraftLine, 'en draft line exists');
  assert.ok(!/[\u4e00-\u9fff]/.test(enDraftLine), 'en draft text carries no Chinese');
  assert.match(enDraftLine, /long-running task/, 'en draft keeps the intent');
});
