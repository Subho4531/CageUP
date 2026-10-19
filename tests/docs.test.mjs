import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('documentation scaffold passes the repository contract check', async () => {
  const { spawn } = await import('node:child_process');

  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['scripts/check-docs.mjs'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(stderr || `Documentation check exited with ${code}`));
      }
    });
  });
});

test('README documents the current not-yet-implemented runtime state', async () => {
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  assert.match(readme, /first TypeScript contracts and configuration loader/);
  assert.match(readme, /cageup opencode/);
  assert.match(readme, /ZK Key Injection/);
});
