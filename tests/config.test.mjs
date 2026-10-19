import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, loadConfig } from '../dist/core/config.js';

test('simulator configuration has safe defaults except workspace', () => {
  const config = loadConfig({
    CAGEUP_WORKSPACE: 'C:/Projects/demo',
    CAGEUP_ZK_GATEWAY_URL: 'http://127.0.0.1:8787'
  });

  assert.equal(config.provider, 'simulator');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.workspace, 'C:/Projects/demo');
  assert.equal(config.daytonaApiToken, undefined);
});

test('Daytona configuration requires provider credentials', () => {
  assert.throws(
    () => loadConfig({
      CAGEUP_PROVIDER: 'daytona',
      CAGEUP_WORKSPACE: 'C:/Projects/demo',
      CAGEUP_ZK_GATEWAY_URL: 'http://127.0.0.1:8787',
      DAYTONA_API_URL: 'https://app.daytona.io/api'
    }),
    (error) => error instanceof ConfigError && error.message === 'DAYTONA_API_TOKEN is required'
  );
});

test('invalid providers are rejected instead of silently falling back', () => {
  assert.throws(
    () => loadConfig({
      CAGEUP_PROVIDER: 'unknown',
      CAGEUP_WORKSPACE: 'C:/Projects/demo',
      CAGEUP_ZK_GATEWAY_URL: 'http://127.0.0.1:8787'
    }),
    (error) => error instanceof ConfigError && error.message.includes('CAGEUP_PROVIDER')
  );
});
