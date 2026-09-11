const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, 'src', 'main');
const outputRoot = path.join(repoRoot, 'dist-electron', 'main');

function copyJavaScriptFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const sourcePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      copyJavaScriptFiles(sourcePath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const relativePath = path.relative(sourceRoot, sourcePath);
    const outputPath = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(sourcePath, outputPath);
  }
}

copyJavaScriptFiles(sourceRoot);
console.log(`[compile:electron] copied JavaScript runtime modules to ${path.relative(repoRoot, outputRoot)}`);
