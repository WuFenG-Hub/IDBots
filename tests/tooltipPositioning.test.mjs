import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tooltipSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'ui', 'Tooltip.tsx'),
  'utf8',
);

test('tooltips use viewport coordinates outside transformed layout containers', () => {
  assert.match(tooltipSource, /createPortal\([\s\S]*?document\.body/);
  assert.match(tooltipSource, /position: 'fixed'/);
  assert.match(tooltipSource, /visibility: 'hidden'/);
  assert.match(tooltipSource, /setTooltipStyle\(null\);[\s\S]*?setIsVisible\(true\)/);
  assert.doesNotMatch(tooltipSource, /className=\{`absolute z-\[100\]/);
});
