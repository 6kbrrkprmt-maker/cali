const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'apps', 'api', 'public');
const outputDir = path.join(rootDir, 'public');

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
copyDirectory(sourceDir, rootDir);
copyDirectory(sourceDir, outputDir);
console.log(`Synced root website files from ${path.relative(rootDir, sourceDir)}`);
console.log(`Prepared Vercel static output: ${path.relative(rootDir, outputDir)}`);