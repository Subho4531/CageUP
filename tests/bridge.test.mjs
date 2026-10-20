import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CageBridge, CageBridgeError } from '../dist/bridge.js';

const operations = [
  'workspace.list',
  'workspace.read',
  'workspace.write',
  'workspace.stat',
  'workspace.diff'
];

function lease(workspaceRoot, allowedOperations = operations, expiresAt = '2099-01-01T00:00:00.000Z') {
  return {
    workspaceRoot,
    operations: allowedOperations,
    expiresAt
  };
}

async function fixtures() {
  const workspace = await mkdtemp(join(tmpdir(), 'cageup-bridge-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'cageup-bridge-outside-'));
  await writeFile(join(workspace, 'input.txt'), 'original\n');
  await mkdir(join(workspace, 'nested'));
  await writeFile(join(outside, 'secret.txt'), 'outside secret\n');
  return { workspace, outside };
}

test('CageBridge lists, reads, stats, writes, and diffs only the selected workspace', async (t) => {
  const { workspace, outside } = await fixtures();
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));

  const bridge = await CageBridge.open(lease(workspace));
  const listed = await bridge.list();
  assert.deepEqual(listed.map((entry) => entry.path), ['input.txt', 'nested']);
  assert.equal(await bridge.read('./input.txt'), 'original\n');
  assert.equal((await bridge.stat('input.txt')).kind, 'file');

  const written = await bridge.write('nested/created.txt', 'created\n');
  assert.equal(written.path, 'nested/created.txt');
  assert.equal(await readFile(join(workspace, 'nested', 'created.txt'), 'utf8'), 'created\n');
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside secret\n');

  const changes = await bridge.diff();
  assert.deepEqual(changes.map((change) => [change.path, change.status]), [['nested/created.txt', 'added']]);
});

test('CageBridge rejects absolute paths and traversal', async (t) => {
  const { workspace, outside } = await fixtures();
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  const bridge = new CageBridge(lease(workspace));

  await assert.rejects(() => bridge.read('../cageup-bridge-outside/secret.txt'), (error) => {
    return error instanceof CageBridgeError && error.code === 'INVALID_PATH';
  });
  await assert.rejects(() => bridge.write(resolve(outside, 'written.txt'), 'blocked'), /absolute paths are not allowed/);
  await assert.rejects(() => bridge.read('nested/../../outside.txt'), /path traversal is not allowed/);
});

test('CageBridge rejects symlink escapes when the platform permits symlinks', async (t) => {
  const { workspace, outside } = await fixtures();
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));

  try {
    await symlink(outside, join(workspace, 'escape'), 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === '不支持此功能') {
      t.skip('symlink creation is not supported by this environment');
      return;
    }
    throw error;
  }

  const bridge = new CageBridge(lease(workspace));
  await assert.rejects(() => bridge.read('escape/secret.txt'), (error) => {
    return error instanceof CageBridgeError && error.code === 'PATH_ESCAPE';
  });
  await assert.rejects(() => bridge.write('escape/new.txt', 'blocked'), (error) => {
    return error instanceof CageBridgeError && error.code === 'PATH_ESCAPE';
  });
});

test('CageBridge enforces denied operations and validates lease operation values', async (t) => {
  const { workspace, outside } = await fixtures();
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));

  const bridge = new CageBridge(lease(workspace, ['workspace.list']));
  await assert.rejects(() => bridge.read('input.txt'), (error) => {
    return error instanceof CageBridgeError && error.code === 'OPERATION_DENIED';
  });
  assert.throws(
    () => new CageBridge(lease(workspace, ['workspace.execute'])),
    (error) => error instanceof CageBridgeError && error.code === 'INVALID_LEASE'
  );
});

test('CageBridge rejects an expired lease before touching the workspace', async (t) => {
  const { workspace, outside } = await fixtures();
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));

  const bridge = new CageBridge(
    lease(workspace, operations, '2026-10-19T00:00:00.000Z'),
    { clock: () => new Date('2026-10-20T00:00:00.000Z') }
  );
  await assert.rejects(() => bridge.list(), (error) => {
    return error instanceof CageBridgeError && error.code === 'LEASE_EXPIRED';
  });
});

test('CageBridge exposes no shell or arbitrary execution API', async (t) => {
  const { workspace, outside } = await fixtures();
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));

  const bridge = new CageBridge(lease(workspace));
  for (const name of ['exec', 'execute', 'spawn', 'shell', 'run', 'command']) {
    assert.equal(typeof bridge[name], 'undefined', `${name} must not be exposed`);
  }
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(bridge)).filter((name) => /exec|spawn|shell|run|command/i.test(name)),
    []
  );
});
