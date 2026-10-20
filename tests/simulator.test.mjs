import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SimulatorProvider } from '../dist/providers/simulator.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cageup-host-fixture-'));
  await writeFile(join(root, 'input.txt'), 'original\n');
  return root;
}

async function run(provider, handle, command, args) {
  const events = [];
  for await (const event of provider.execute(handle, command, args)) events.push(event);
  return events;
}

test('simulator isolates, executes, collects, and destroys a workspace', async (t) => {
  const host = await fixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  const provider = new SimulatorProvider({ idFactory: () => 'test' });
  const handle = await provider.createRun({
    workspaceRoot: host,
    provider: 'simulator',
    command: process.execPath,
    commandArgs: []
  });

  await provider.uploadWorkspace(handle, host);
  const events = await run(provider, handle, process.execPath, [
    '-e',
    "require('node:fs').writeFileSync('created.txt', require('node:fs').readFileSync('input.txt', 'utf8') + 'changed\\n')"
  ]);
  const manifest = await provider.collectWorkspace(handle);

  assert.deepEqual(events.map((event) => event.type), ['COMMAND_STARTED', 'COMMAND_EXITED']);
  assert.ok(manifest.entries.some((entry) => entry.path === 'created.txt'));
  assert.equal(await readFile(join(host, 'input.txt'), 'utf8'), 'original\n');
  await provider.destroy(handle);
  await assert.rejects(() => provider.collectWorkspace(handle), /not available/);
});

test('simulator preserves exact argument boundaries', async (t) => {
  const host = await fixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  const provider = new SimulatorProvider();
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: process.execPath, commandArgs: [] });
  await provider.uploadWorkspace(handle, host);
  const args = ['--model', 'test model', '--flag=value', 'quote"value', ''];
  const expected = JSON.stringify(args);
  const script = `const expected = ${JSON.stringify(expected)}; if (JSON.stringify(process.argv.slice(1)) !== expected) process.exit(9); require('node:fs').writeFileSync('args.json', expected)`;
  await run(provider, handle, process.execPath, ['-e', script, '--', ...args]);
  const manifest = await provider.collectWorkspace(handle);
  assert.ok(manifest.entries.some((entry) => entry.path === 'args.json'));
  await provider.destroy(handle);
});

test('simulator rejects execution before upload and is safe to destroy twice', async (t) => {
  const host = await fixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  const provider = new SimulatorProvider();
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: 'node', commandArgs: [] });
  await assert.rejects(async () => {
    for await (const _event of provider.execute(handle, process.execPath, ['-e', ''])) { /* expected rejection */ }
  }, /uploaded/);
  await provider.destroy(handle);
  await provider.destroy(handle);
});

test('simulator reports failed commands without modifying the host', async (t) => {
  const host = await fixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  const provider = new SimulatorProvider();
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: process.execPath, commandArgs: [] });
  await provider.uploadWorkspace(handle, host);
  await assert.rejects(async () => {
    for await (const _event of provider.execute(handle, process.execPath, ['-e', 'process.exit(7)'])) { /* expected failure */ }
  }, /exit code 7/);
  assert.equal(await readFile(join(host, 'input.txt'), 'utf8'), 'original\n');
  await provider.destroy(handle);
});
