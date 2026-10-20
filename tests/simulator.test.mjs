import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('simulator rejects symlinks anywhere in the uploaded workspace', async (t) => {
  const host = await fixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  await symlink(join(host, 'input.txt'), join(host, 'nested-link.txt'));
  const provider = new SimulatorProvider();
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: process.execPath, commandArgs: [] });

  await assert.rejects(() => provider.uploadWorkspace(handle, host), /does not support symlinks: nested-link\.txt/);
  await provider.destroy(handle);
});

test('simulator passes only allowlisted runtime environment values to commands', async (t) => {
  const host = await fixture();
  const exported = join(dirname(host), 'env-export');
  t.after(() => rm(host, { recursive: true, force: true }));
  t.after(() => rm(exported, { recursive: true, force: true }));
  const secret = 'simulator-host-secret-value';
  const provider = new SimulatorProvider({
    env: {
      PATH: process.env.PATH,
      HOME: '/safe/test-home',
      CAGEUP_TEST_SECRET: secret
    }
  });
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: process.execPath, commandArgs: [] });
  await provider.uploadWorkspace(handle, host);
  await run(provider, handle, process.execPath, [
    '-e',
    "require('node:fs').writeFileSync('env.json', JSON.stringify({ secret: process.env.CAGEUP_TEST_SECRET, simulator: process.env.CAGEUP_SIMULATOR, path: process.env.PATH, home: process.env.HOME, keys: Object.keys(process.env).sort() }))"
  ]);

  await provider.exportWorkspace(handle, exported);
  const observed = JSON.parse(await readFile(join(exported, 'env.json'), 'utf8'));
  assert.equal(observed.secret, undefined);
  assert.equal(observed.simulator, '1');
  assert.equal(observed.path, process.env.PATH);
  assert.equal(observed.home, '/safe/test-home');
  assert.deepEqual(observed.keys, ['CAGEUP_SIMULATOR', 'HOME', 'PATH']);
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(secret));
  await provider.destroy(handle);
});

test('simulator drains command output without changing lifecycle events', async (t) => {
  const host = await fixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  const provider = new SimulatorProvider();
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: process.execPath, commandArgs: [] });
  await provider.uploadWorkspace(handle, host);
  const events = await run(provider, handle, process.execPath, [
    '-e',
    "process.stdout.write('o'.repeat(1024 * 1024)); process.stderr.write('e'.repeat(1024 * 1024)); require('node:fs').writeFileSync('output-drained.txt', 'done')"
  ]);

  assert.deepEqual(events.map((event) => event.type), ['COMMAND_STARTED', 'COMMAND_EXITED']);
  const manifest = await provider.collectWorkspace(handle);
  assert.ok(manifest.entries.some((entry) => entry.path === 'output-drained.txt'));
  await provider.destroy(handle);
});

test('simulator rejects export destinations inside the host workspace, including symlink aliases', async (t) => {
  const host = await fixture();
  const alias = join(dirname(host), 'workspace-alias');
  t.after(async () => {
    await rm(alias, { force: true }).catch(() => undefined);
    await rm(host, { recursive: true, force: true });
  });
  await symlink(host, alias, 'dir');

  const provider = new SimulatorProvider();
  const handle = await provider.createRun({ workspaceRoot: host, provider: 'simulator', command: process.execPath, commandArgs: [] });
  await provider.uploadWorkspace(handle, host);

  await assert.rejects(() => provider.exportWorkspace(handle, join(host, 'direct-export')), /outside the host workspace/);
  await assert.rejects(() => provider.exportWorkspace(handle, join(alias, 'aliased-export')), /symlinked path component/);
  await assert.rejects(() => lstat(join(host, 'aliased-export')));
  await provider.destroy(handle);
});
