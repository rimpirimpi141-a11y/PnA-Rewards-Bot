import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function collectJsFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

const files = [
  ...collectJsFiles(path.resolve('src')),
  ...collectJsFiles(path.resolve('scripts')),
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`Syntax verified for ${files.length} JavaScript ES Module files.`);
