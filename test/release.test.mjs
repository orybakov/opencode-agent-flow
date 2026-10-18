import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('0.1.2 package version, CLI help and dated changelog agree', () => {
  const root = new URL('../', import.meta.url);
  const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(version, '0.1.2');
  const help = execFileSync(process.execPath, ['bin/cli.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /^opencode-agent-flow 0\.1\.2 —/);
  assert.match(readFileSync(new URL('CHANGELOG.md', root), 'utf8'), /## \[0\.1\.2\] - 2026-10-18/);
});
