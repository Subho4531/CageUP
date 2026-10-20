import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { SessionRecoveryError, SessionRuntime } from '../dist/session.js';
import { SimulatorProvider } from '../dist/providers/simulator.js';

const fixedTime = '2026-10-20T00:00:00.000Z';

class FakeProvider {
  calls = [];
  nextId = 1;

  async createRun(spec) {
    this.calls.push(['createRun', spec]);
    return { provider: spec.provider, id: `sandbox-${this.nextId++}`, createdAt: fixedTime };
  }

  async uploadWorkspace(handle, source) {
    this.calls.push(['uploadWorkspace', handle.id, source]);
  }

  async *execute(handle, command, args) {
    this.calls.push(['execute', handle.id, command, [...args]]);
    yield { id: 'provider-event', type: 'COMMAND_STARTED', runId: handle.id, occurredAt: fixedTime, payload: { command, argumentCount: args.length, message: 'Bearer real-secret-value' }, previousHash: null, hash: 'provider-hash' };
    yield { id: 'provider-exit', type: 'COMMAND_EXITED', runId: handle.id, occurredAt: fixedTime, payload: { exitCode: 0 }, previousHash: null, hash: 'provider-exit-hash' };
  }

  async collectWorkspace(handle) {
    this.calls.push(['collectWorkspace', handle.id]);
    return {
      root: '/workspace/project',
      createdAt: fixedTime,
      entries: [
        { path: 'input.txt', kind: 'file', size: 8, sha256: 'result-input' },
        { path: 'created.txt', kind: 'file', size: 7, sha256: 'created-hash' },
        { path: '.github', kind: 'directory', size: 0 },
        { path: '.github/workflows', kind: 'directory', size: 0 },
        { path: '.github/workflows/ci.yml', kind: 'file', size: 4, sha256: 'ci-hash' }
      ],
      hash: 'result-manifest'
    };
  }

  async destroy(handle) {
    this.calls.push(['destroy', handle.id]);
  }
}

class FailedStartProvider extends FakeProvider {
  async uploadWorkspace(handle, source) {
    this.calls.push(['uploadWorkspace', handle.id, source]);
    throw new Error('original start failure Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=');
  }

  async destroy(handle) {
    this.calls.push(['destroy', handle.id]);
    throw new Error('cleanup failure Cookie: session=cleanup-secret');
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cageup-session-test-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  await mkdir(workspace);
  await writeFile(join(workspace, 'input.txt'), 'original\n');
  return { root, workspace, state };
}

function request(workspace) {
  return {
    workspaceRoot: workspace,
    provider: 'simulator',
    command: 'opencode',
    commandArgs: ['--model', 'test model', '--token', 'real-secret-value', 'Bearer real-secret-value', ''],
    lease: {
      operations: ['workspace.list', 'workspace.read', 'workspace.write', 'workspace.diff', 'promotion.submit', 'run.status'],
      allowedDomains: ['api.example.com'],
      expiresAt: '2026-10-20T01:00:00.000Z'
    }
  };
}

function runtimeFor(provider, state) {
  let id = 0;
  return new SessionRuntime({
    stateDir: state,
    clock: () => new Date(fixedTime),
    idFactory: () => `id-${++id}`,
    providerFactory: () => provider
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('start persists a safe record, preserves exact execution args, and exposes inspection operations', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const runtime = runtimeFor(provider, paths.state);
  const record = await runtime.start(request(paths.workspace));

  assert.equal(record.state, 'collected');
  assert.equal(record.handle.id, 'sandbox-1');
  const execution = provider.calls.find((call) => call[0] === 'execute');
  assert.deepEqual(execution[3], request(paths.workspace).commandArgs);

  const files = await readdir(join(paths.state, 'sessions'));
  assert.deepEqual(files, [`${record.id}.json`]);
  const persisted = await readFile(join(paths.state, 'sessions', files[0]), 'utf8');
  assert.doesNotMatch(persisted, /real-secret-value/);
  assert.doesNotMatch(persisted, /Bearer /i);

  assert.equal((await runtime.status(record.id)).runtimeAvailable, true);
  assert.deepEqual((await runtime.policy(record.id)).allowedDomains, ['api.example.com']);
  assert.ok((await runtime.evidence(record.id)).some((event) => event.type === 'COMMAND_EXITED'));

  const changes = await runtime.diff(record.id);
  assert.deepEqual(changes.map((change) => [change.path, change.kind]), [
    ['.github', 'added'],
    ['.github/workflows', 'added'],
    ['.github/workflows/ci.yml', 'added'],
    ['created.txt', 'added'],
    ['input.txt', 'modified']
  ]);
  const review = await runtime.review(record.id);
  assert.equal(review.decisions.find((decision) => decision.path === 'created.txt').decision, 'allow');
  assert.equal(review.decisions.find((decision) => decision.path === '.github/workflows/ci.yml').decision, 'quarantine');
  assert.equal((await runtime.load(record.id)).review.decisions.length, review.decisions.length);
  await assert.rejects(() => runtime.promote(record.id, ['created.txt']), /no exported result root/);
});

test('persisted inspection survives a fresh runtime while control operations return a clear recovery error', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const original = runtimeFor(provider, paths.state);
  const record = await original.start(request(paths.workspace));

  const restarted = new SessionRuntime({ stateDir: paths.state, clock: () => new Date(fixedTime) });
  assert.equal((await restarted.status(record.id)).runtimeAvailable, false);
  assert.equal((await restarted.policy(record.id)).policyHash.startsWith('sha256:'), true);
  await assert.rejects(
    () => restarted.rollback(record.id),
    (error) => error instanceof SessionRecoveryError && error.code === 'RECOVERY_UNAVAILABLE' && error.message.includes('inspection')
  );
});

test('revoke and rollback use the live in-process control plane and never write to the host workspace', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const runtime = runtimeFor(provider, paths.state);
  const record = await runtime.start(request(paths.workspace));

  const revoked = await runtime.revoke(record.id);
  assert.equal(revoked.state, 'revoked');
  assert.equal((await runtime.status(record.id)).state, 'revoked');
  const rolledBack = await runtime.rollback(record.id);
  assert.equal(rolledBack.state, 'rolled_back');
  assert.deepEqual(provider.calls.filter((call) => call[0] === 'destroy'), [['destroy', 'sandbox-1']]);
  assert.equal(await readFile(join(paths.workspace, 'input.txt'), 'utf8'), 'original\n');
});

test('state directories inside the selected workspace are rejected before provider creation', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  let created = false;
  const runtime = new SessionRuntime({
    stateDir: join(paths.workspace, '.cageup'),
    providerFactory: () => {
      created = true;
      return new FakeProvider();
    },
    clock: () => new Date(fixedTime)
  });
  await assert.rejects(() => runtime.start(request(paths.workspace)), /state_directory_unsafe/);
  assert.equal(created, false);
});

test('canonicalizes symlinked state roots and rejects state roots resolving inside the workspace', async (t) => {
  const paths = await fixture();
  const externalState = join(paths.root, 'external-state');
  const stateLink = join(paths.root, 'state-link');
  await mkdir(externalState);
  await symlink(externalState, stateLink, 'dir');
  t.after(() => rm(paths.root, { recursive: true, force: true }));

  const runtime = runtimeFor(new FakeProvider(), join(stateLink, 'nested', 'sessions-state'));
  const record = await runtime.start(request(paths.workspace));
  assert.equal(await exists(join(externalState, 'nested', 'sessions-state', 'sessions', `${record.id}.json`)), true);

  const workspaceStateTarget = join(paths.workspace, '.inside-state');
  const workspaceStateLink = join(paths.root, 'workspace-state-link');
  await mkdir(workspaceStateTarget);
  await symlink(workspaceStateTarget, workspaceStateLink, 'dir');
  const unsafe = new SessionRuntime({
    stateDir: workspaceStateLink,
    providerFactory: () => new FakeProvider(),
    clock: () => new Date(fixedTime)
  });
  await assert.rejects(() => unsafe.start(request(paths.workspace)), /state_directory_unsafe/);
});

test('promotion validates the live lease, permission, expiry, and policy hash', async (t) => {
  const revokedPaths = await fixture();
  t.after(() => rm(revokedPaths.root, { recursive: true, force: true }));
  const revokedRuntime = runtimeFor(new FakeProvider(), revokedPaths.state);
  const revokedRecord = await revokedRuntime.start(request(revokedPaths.workspace));
  await revokedRuntime.review(revokedRecord.id);
  await revokedRuntime.revoke(revokedRecord.id);
  await assert.rejects(() => revokedRuntime.promote(revokedRecord.id, []), /lease_revoked/i);

  const expiredPaths = await fixture();
  t.after(() => rm(expiredPaths.root, { recursive: true, force: true }));
  let now = new Date(fixedTime);
  const expiredRuntime = new SessionRuntime({
    stateDir: expiredPaths.state,
    clock: () => now,
    idFactory: (() => { let id = 0; return () => `expired-${++id}`; })(),
    providerFactory: () => new FakeProvider()
  });
  const expiredRecord = await expiredRuntime.start(request(expiredPaths.workspace));
  await expiredRuntime.review(expiredRecord.id);
  now = new Date('2026-10-20T02:00:00.000Z');
  await assert.rejects(() => expiredRuntime.promote(expiredRecord.id, []), /lease_expired/i);

  const tamperedPaths = await fixture();
  t.after(() => rm(tamperedPaths.root, { recursive: true, force: true }));
  const tamperedRuntime = runtimeFor(new FakeProvider(), tamperedPaths.state);
  const tamperedRecord = await tamperedRuntime.start(request(tamperedPaths.workspace));
  await tamperedRuntime.review(tamperedRecord.id);
  const persistedPath = join(tamperedPaths.state, 'sessions', `${tamperedRecord.id}.json`);
  const persistedRecord = JSON.parse(await readFile(persistedPath, 'utf8'));
  persistedRecord.lease.policyHash = 'sha256:tampered';
  await writeFile(persistedPath, `${JSON.stringify(persistedRecord)}\n`);
  await assert.rejects(() => tamperedRuntime.promote(tamperedRecord.id, []), /policy hash/i);

  const permissionPaths = await fixture();
  t.after(() => rm(permissionPaths.root, { recursive: true, force: true }));
  const permissionRuntime = runtimeFor(new FakeProvider(), permissionPaths.state);
  const permissionRecord = await permissionRuntime.start({
    ...request(permissionPaths.workspace),
    lease: { ...request(permissionPaths.workspace).lease, operations: ['workspace.list', 'workspace.diff', 'run.status'] }
  });
  await permissionRuntime.review(permissionRecord.id);
  await assert.rejects(() => permissionRuntime.promote(permissionRecord.id, []), /promotion\.submit/);
});

test('failed starts clean up the sandbox, preserve the original error, and redact cleanup failures', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new FailedStartProvider();
  const runtime = runtimeFor(provider, paths.state);

  let failedId;
  await assert.rejects(
    () => runtime.start(request(paths.workspace)),
    (error) => {
      failedId = error.sessionId;
      return error.sessionId?.startsWith('session_') && error.message.includes('original start failure') && !error.message.includes('dXNlcj');
    }
  );
  assert.deepEqual(provider.calls.map((call) => call[0]), ['createRun', 'uploadWorkspace', 'destroy']);

  const failed = await runtime.load(failedId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error.message, /original start failure/);
  assert.doesNotMatch(JSON.stringify(failed), /dXNlcj|cleanup-secret|Basic /i);
  assert.match(failed.cleanupError.message, /cleanup failure/);
  assert.equal((await runtime.status(failed.id)).runtimeAvailable, false);
});

test('persisted command arguments redact Basic auth and Authorization/Cookie header credentials', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const runtime = runtimeFor(provider, paths.state);
  const record = await runtime.start({
    ...request(paths.workspace),
    commandArgs: [
      '--auth', 'user:password-value',
      '-H', 'Authorization: Basic dXNlcjpzZWNyZXQ=',
      '--header=Cookie: session=cookie-secret',
      '--header', 'Authorization: Bearer bearer-secret',
      'Basic dXNlcjpzZWNyZXQ='
    ]
  });
  const persisted = await readFile(join(paths.state, 'sessions', `${record.id}.json`), 'utf8');
  assert.doesNotMatch(persisted, /password-value|dXNlcjpzZWNyZXQ=|cookie-secret|bearer-secret|Basic /i);
  assert.match(persisted, /\[REDACTED\]/);
});

test('simulator stages results outside the host, promotes only selected allows, protects quarantine, and restores after restart', async (t) => {
  const paths = await fixture();
  await mkdir(join(paths.root, 'simulator'));
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new SimulatorProvider({
    tempRoot: join(paths.root, 'simulator'),
    idFactory: () => 'session-test'
  });
  const runtime = runtimeFor(provider, paths.state);
  const record = await runtime.start({
    ...request(paths.workspace),
    command: process.execPath,
    commandArgs: ['-e', "const fs=require('node:fs');fs.writeFileSync('created.txt','worker\\n');fs.mkdirSync('.github/workflows',{recursive:true});fs.writeFileSync('.github/workflows/ci.yml','worker ci\\n');"]
  });

  assert.ok(record.resultRoot);
  assert.equal(relative(paths.workspace, record.resultRoot).startsWith('..'), true);
  assert.equal(await readFile(join(record.resultRoot, 'created.txt'), 'utf8'), 'worker\n');
  assert.equal(await readFile(join(paths.workspace, 'input.txt'), 'utf8'), 'original\n');

  const review = await runtime.review(record.id);
  const created = review.decisions.find((decision) => decision.path === 'created.txt');
  const quarantined = review.decisions.find((decision) => decision.path === '.github/workflows/ci.yml');
  assert.equal(created?.decision, 'allow');
  assert.equal(quarantined?.decision, 'quarantine');

  const released = await runtime.release(record.id);
  assert.equal(released.state, 'destroyed');
  assert.equal(released.runtime.availability, 'destroyed');
  assert.equal(released.resultRoot, record.resultRoot);
  assert.equal(released.review.decisions.length, review.decisions.length);

  const restarted = new SessionRuntime({ stateDir: paths.state, clock: () => new Date(fixedTime) });
  await assert.rejects(() => restarted.promote(record.id, ['.github/workflows/ci.yml']), /quarantine/);
  assert.equal(await exists(join(paths.workspace, '.github', 'workflows', 'ci.yml')), false);

  const promoted = await restarted.promote(record.id, ['created.txt']);
  assert.equal(promoted.promotion.status, 'promoted');
  assert.equal(await readFile(join(paths.workspace, 'created.txt'), 'utf8'), 'worker\n');
  assert.equal(await exists(join(paths.workspace, '.github', 'workflows', 'ci.yml')), false);

  const rolledBack = await restarted.rollback(record.id);
  assert.equal(rolledBack.state, 'rolled_back');
  assert.equal(await exists(join(paths.workspace, 'created.txt')), false);
  assert.equal(await readFile(join(paths.workspace, 'input.txt'), 'utf8'), 'original\n');
  assert.equal((await restarted.load(record.id)).promotion.status, 'rolled_back');
});

test('simulator promotion refuses a changed host baseline and never overwrites it', async (t) => {
  const paths = await fixture();
  await mkdir(join(paths.root, 'simulator'));
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const provider = new SimulatorProvider({ tempRoot: join(paths.root, 'simulator') });
  const runtime = runtimeFor(provider, paths.state);
  const record = await runtime.start({
    ...request(paths.workspace),
    command: process.execPath,
    commandArgs: ['-e', "require('node:fs').writeFileSync('input.txt','worker\\n')"]
  });
  await runtime.review(record.id);
  await writeFile(join(paths.workspace, 'input.txt'), 'operator change\n');

  await assert.rejects(() => runtime.promote(record.id, ['input.txt']), /host changed since baseline/);
  assert.equal(await readFile(join(paths.workspace, 'input.txt'), 'utf8'), 'operator change\n');
});
