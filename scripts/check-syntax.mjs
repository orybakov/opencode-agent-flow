import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let count = 0;
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'vendor'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
      count++;
    }
  }
}
check(root);
console.log(`Syntax OK: ${count} JavaScript files (vendor excluded).`);
