import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOpenCodeInvocation } from '../dist/cli.js';

const root = new URL('..', import.meta.url);
const cli = new URL('../dist/cli.js', import.meta.url);

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of [
    'CAGEUP_PROVIDER',
    'CAGEUP_WORKSPACE',
    'CAGEUP_ZK_GATEWAY_URL',
    'CAGEUP_LOG_LEVEL',
    'CAGEUP_STATE_DIR',
    'CAGEUP_COMMAND',
    'CAGEUP_OPENCODE_COMMAND',
    'DAYTONA_API_URL',
    'DAYTONA_API_TOKEN'
  ]) {
    if (!(name in overrides)) delete env[name];
  }
  return env;
}

function runCli(args, env = cleanEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli.pathname, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function lifecycleFixture(t) {
  const rootPath = await mkdtemp(join(tmpdir(), 'cageup-cli-test-'));
  const workspace = join(rootPath, 'workspace');
  const state = join(rootPath, 'state');
  await mkdir(workspace);
  await writeFile(join(workspace, 'input.txt'), 'original\n');
  t.after(() => rm(rootPath, { recursive: true, force: true }));

  const args = ['--model', 'test model', '--message', 'quote"value', ''];
  const fixtureScript = "const fs=require('node:fs');const encoded=Buffer.from(JSON.stringify(process.argv.slice(1))).toString('base64url');fs.writeFileSync('forwarded-'+encoded+'.txt','fixture');fs.writeFileSync('created.txt','fixture');fs.mkdirSync('.github/workflows',{recursive:true});fs.writeFileSync('.github/workflows/ci.yml','protected');";
  const env = cleanEnv({
    CAGEUP_PROVIDER: 'simulator',
    CAGEUP_WORKSPACE: workspace,
    CAGEUP_ZK_GATEWAY_URL: 'http://127.0.0.1:8787',
    CAGEUP_STATE_DIR: state,
    CAGEUP_COMMAND: process.execPath
  });
  return { workspace, state, args, fixtureScript, env };
}

test('help lists the complete operator command surface', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  for (const command of ['doctor', 'config', 'status', 'policy', 'diff', 'review', 'promote', 'reject', 'revoke', 'rollback', 'opencode']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test('doctor is useful offline and does not require live configuration', async () => {
  const result = await runCli(['doctor']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CageUP doctor/);
  assert.match(result.stdout, /configuration: unavailable/);
  assert.match(result.stdout, /external session store/);
});

test('config reports validation errors without exposing a token', async () => {
  const token = 'should-never-be-printed';
  const result = await runCli(['config'], cleanEnv({
    CAGEUP_PROVIDER: 'daytona',
    CAGEUP_WORKSPACE: '/tmp/project',
    CAGEUP_ZK_GATEWAY_URL: 'http://127.0.0.1:8787',
    DAYTONA_API_URL: 'https://daytona.example.test/api',
    DAYTONA_API_TOKEN: token
  }));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[redacted\]/);
  assert.doesNotMatch(result.stdout, new RegExp(token));

  const invalid = await runCli(['config'], cleanEnv({
    CAGEUP_PROVIDER: 'daytona',
    CAGEUP_WORKSPACE: '/tmp/project',
    CAGEUP_ZK_GATEWAY_URL: 'http://127.0.0.1:8787',
    DAYTONA_API_URL: 'https://daytona.example.test/api'
  }));
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /CageUP configuration error: DAYTONA_API_TOKEN is required/);
  assert.doesNotMatch(invalid.stderr, /should-never-be-printed/);
});

test('OpenCode argument forwarding preserves exact boundaries after --', async () => {
  const args = ['--model', 'test model', '--message', 'quote"value', ''];
  assert.deepEqual(parseOpenCodeInvocation(['--', ...args]), { command: 'opencode', args });
});

test('simulator lifecycle persists safe status, policy, diff, and review output', async (t) => {
  const fixture = await lifecycleFixture(t);
  const started = await runCli(['opencode', '--', '-e', fixture.fixtureScript, '--', ...fixture.args], fixture.env);
  assert.equal(started.code, 0, started.stderr);
  assert.doesNotMatch(started.stdout, /fixtureScript|process\.execPath/);
  const summary = JSON.parse(started.stdout);
  assert.equal(summary.state, 'destroyed');
  assert.equal(summary.provider, 'simulator');
  assert.equal(summary.availability, 'destroyed');

  const currentSession = (await readFile(join(fixture.state, 'current-session'), 'utf8')).trim();
  assert.equal(currentSession, summary.sessionId);

  const status = await runCli(['status'], fixture.env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).runtimeAvailable, false);
  assert.doesNotMatch(status.stdout, /should-never-be-printed|Bearer |token=/i);

  const policy = await runCli(['policy', '--session', summary.sessionId], fixture.env);
  assert.equal(policy.code, 0, policy.stderr);
  assert.deepEqual(JSON.parse(policy.stdout).operations, [
    'promotion.submit',
    'run.status',
    'workspace.diff',
    'workspace.list',
    'workspace.read',
    'workspace.stat',
    'workspace.write'
  ]);

  const diff = await runCli(['diff'], fixture.env);
  assert.equal(diff.code, 0, diff.stderr);
  const changes = JSON.parse(diff.stdout).changes;
  assert.ok(changes.some((change) => change.path === 'created.txt'));
  assert.ok(changes.some((change) => change.path === '.github/workflows/ci.yml'));
  const expectedForwarded = Buffer.from(JSON.stringify(fixture.args)).toString('base64url');
  assert.ok(changes.some((change) => change.path === `forwarded-${expectedForwarded}.txt`), changes.map((change) => change.path));

  const review = await runCli(['review'], fixture.env);
  assert.equal(review.code, 0, review.stderr);
  const reviewBody = JSON.parse(review.stdout);
  assert.equal(reviewBody.sessionId, summary.sessionId);
  assert.equal(reviewBody.decisions.find((decision) => decision.path === 'created.txt').decision, 'allow');
  assert.equal(reviewBody.decisions.find((decision) => decision.path === '.github/workflows/ci.yml').decision, 'quarantine');

  const allAllowed = await runCli(['promote', '--session', summary.sessionId, '--all-allowed'], fixture.env);
  assert.equal(allAllowed.code, 0, allAllowed.stderr);
  const allAllowedBody = JSON.parse(allAllowed.stdout);
  assert.equal(allAllowedBody.hostWrites, true);
  assert.ok(allAllowedBody.quarantinedPaths.includes('.github/workflows/ci.yml'));
  assert.equal(await readFile(join(fixture.workspace, 'created.txt'), 'utf8'), 'fixture');
  await assert.rejects(() => readFile(join(fixture.workspace, '.github', 'workflows', 'ci.yml'), 'utf8'));

  const persisted = await readFile(join(fixture.state, 'sessions', `${summary.sessionId}.json`), 'utf8');
  assert.doesNotMatch(persisted, /should-never-be-printed|Bearer |token=/i);
});

test('fresh CLI processes promote one reviewed path, reject remains no-write, and rollback restores the host', async (t) => {
  const fixture = await lifecycleFixture(t);
  const started = await runCli(['opencode', '--', '-e', fixture.fixtureScript, '--'], fixture.env);
  assert.equal(started.code, 0, started.stderr);
  const sessionId = JSON.parse(started.stdout).sessionId;

  const review = await runCli(['review', '--session', sessionId], fixture.env);
  assert.equal(review.code, 0, review.stderr);

  const expectedForwarded = `forwarded-${Buffer.from(JSON.stringify([])).toString('base64url')}.txt`;
  const promote = await runCli([
    'promote',
    '--session', sessionId,
    '--path', 'created.txt',
    '--path', expectedForwarded
  ], fixture.env);
  assert.equal(promote.code, 0, promote.stderr);
  const promotion = JSON.parse(promote.stdout);
  assert.deepEqual([...promotion.promotedPaths].sort(), ['created.txt', expectedForwarded].sort());
  assert.equal(promotion.hostWrites, true);
  assert.equal(await readFile(join(fixture.workspace, 'created.txt'), 'utf8'), 'fixture');
  assert.equal(await readFile(join(fixture.workspace, expectedForwarded), 'utf8'), 'fixture');
  await assert.rejects(() => readFile(join(fixture.workspace, '.github', 'workflows', 'ci.yml'), 'utf8'));

  const reject = await runCli(['reject', '--session', sessionId], fixture.env);
  assert.equal(reject.code, 2);
  assert.match(reject.stdout, /hostWrites": false/);
  assert.match(reject.stdout, /no host writes were performed/);
  assert.equal(await readFile(join(fixture.workspace, 'created.txt'), 'utf8'), 'fixture');

  const rollback = await runCli(['rollback', '--session', sessionId], fixture.env);
  assert.equal(rollback.code, 0, rollback.stderr);
  assert.equal(JSON.parse(rollback.stdout).state, 'rolled_back');
  await assert.rejects(() => readFile(join(fixture.workspace, 'created.txt'), 'utf8'));
  assert.equal(await readFile(join(fixture.workspace, 'input.txt'), 'utf8'), 'original\n');

  const status = await runCli(['status', '--session', sessionId], fixture.env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).promotion.status, 'rolled_back');
});
