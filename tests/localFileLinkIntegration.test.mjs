import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const markdownSource = readSource('src', 'renderer', 'components', 'MarkdownContent.tsx');
const sessionDetailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const linkSource = readSource('src', 'renderer', 'components', 'ui', 'LocalFileLink.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

test('markdown local file links render through LocalFileLink with a context menu', () => {
  assert.match(markdownSource, /import LocalFileLink from '\.\/ui\/LocalFileLink'/);
  assert.match(markdownSource, /<LocalFileLink[\s\S]*?onOpen=\{\(_path, event\) => handleClick\(event\)\}/);
  // The local-file branch must render inside LocalFileLink (right-click menu),
  // not as a plain anchor with only a click handler.
  assert.match(markdownSource, /const isLocalFilePath[\s\S]*?<LocalFileLink[\s\S]*?<\/LocalFileLink>/);
});

test('cowork image preview strip is wrapped in LocalFileLink', () => {
  assert.match(sessionDetailSource, /import LocalFileLink from '\.\.\/ui\/LocalFileLink'/);
  assert.match(sessionDetailSource, /<LocalFileLink[\s\S]*?filePath=\{imagePath\}/);
  assert.match(sessionDetailSource, /<LocalFileLink[\s\S]*?onOpen=\{\(path\) => \{ void handleOpenPath\(path\); \}\}/);
});

test('LocalFileLink exposes right-click menu with copy actions', () => {
  assert.match(linkSource, /onContextMenu=\{handleContextMenu\}/);
  assert.match(linkSource, /navigator\.clipboard\.writeText\(filePath\)/);
  assert.match(linkSource, /window\.electron\.fs\.readTextFile\(filePath\)/);
  assert.match(linkSource, /window\.electron\.shell\.getOpenWithApps\(filePath\)/);
});

test('file context menu labels are localized in both languages', () => {
  for (const [key, zh, en] of [
    ['fileOpenWith', '用其他应用打开', 'Open With'],
    ['fileCopyPath', '复制路径', 'Copy Path'],
    ['fileCopyContent', '复制文件内容', 'Copy File Content'],
    ['fileRevealInFinder', '在 Finder 中显示', 'Reveal in Finder'],
    ['fileShowInExplorer', '在资源管理器中显示', 'Show in Explorer'],
  ]) {
    assert.match(i18nSource, new RegExp(`${key}: '${zh}'`));
    assert.match(i18nSource, new RegExp(`${key}: '${en}'`));
  }
});
