import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { parseOpenCodeInvocation } from '../dist/cli.js';

const root = new URL('..', import.meta.url);
const cli = new URL('../dist/cli.js', import.meta.url);

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of ['CAGEUP_PROVIDER', 'CAGEUP_WORKSPACE', 'CAGEUP_ZK_GATEWAY_URL', 'CAGEUP_LOG_LEVEL', 'DAYTONA_API_URL', 'DAYTONA_API_TOKEN']) {
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
  assert.match(result.stdout, /live provider: unavailable/);
  assert.match(result.stdout, /configuration: unavailable/);
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

test('OpenCode argument forwarding preserves exact boundaries after -- without logging values', async () => {
  const args = ['--model', 'test model', '--message', 'quote"value', ''];
  assert.deepEqual(parseOpenCodeInvocation(['--', ...args]), { command: 'opencode', args });

  const secret = 'do-not-log-this-value';
  const result = await runCli(['opencode', '--', '--model', 'test model', secret]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /runtime unavailable/);
  assert.match(result.stderr, /3 argument\(s\) preserved/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test('operator actions return safe unavailable-state responses', async () => {
  for (const command of ['status', 'policy', 'diff', 'review', 'promote', 'reject', 'revoke', 'rollback']) {
    const result = await runCli([command]);
    assert.match(`${result.stdout}${result.stderr}`, /unavailable/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /should-never-be-printed|token=|Bearer /i);
  }
});
