import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DAYTONA_ENDPOINTS,
  DaytonaError,
  DaytonaProvider,
  FetchDaytonaClient
} from '../dist/providers/daytona.js';

const token = 'test-daytona-token';
const fixedTime = '2026-10-20T00:00:00.000Z';

class FakeDaytonaServer {
  requests = [];
  sandboxId = 'sandbox-test-1';
  manifest = {
    root: '/workspace/project',
    createdAt: fixedTime,
    entries: [
      { path: 'input.txt', kind: 'file', size: 8, sha256: 'input-hash' },
      { path: 'nested', kind: 'directory', size: 0 }
    ],
    hash: 'manifest-hash'
  };

  async fetch(input, init = {}) {
    const url = new URL(input);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({ method: init.method ?? 'GET', path: url.pathname, headers: new Headers(init.headers), body });

    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    if (url.pathname.endsWith('/sandboxes') && init.method === 'POST') {
      return Response.json({ id: this.sandboxId, createdAt: fixedTime });
    }
    if (url.pathname.endsWith(`/sandboxes/${this.sandboxId}/workspace`) && init.method === 'POST') {
      return Response.json({ accepted: true });
    }
    if (url.pathname.endsWith(`/sandboxes/${this.sandboxId}/execute`) && init.method === 'POST') {
      assert.deepEqual(body.args, ['--model', 'test model', 'quote"value', '']);
      assert.equal(body.command, 'opencode');
      assert.equal(body.cwd, '/workspace/project');
      return Response.json({
        events: [
          { type: 'COMMAND_STARTED', payload: { command: body.command, argumentCount: body.args.length } },
          { type: 'COMMAND_EXITED', payload: { command: body.command, exitCode: 0 } }
        ]
      });
    }
    if (url.pathname.endsWith(`/sandboxes/${this.sandboxId}/workspace/manifest`) && init.method === 'GET') {
      return Response.json(this.manifest);
    }
    if (url.pathname.endsWith(`/sandboxes/${this.sandboxId}`) && init.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cageup-daytona-test-'));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'input.txt'), 'original\n');
  await writeFile(join(root, '.env'), 'SHOULD_NOT_UPLOAD=secret\n');
  await writeFile(join(root, '.env.local'), 'SHOULD_NOT_UPLOAD_EITHER=secret\n');
  await writeFile(join(root, 'nested', 'note.txt'), 'nested\n');
  return root;
}

test('Daytona configuration errors identify missing fields without exposing a token', () => {
  assert.throws(
    () => new FetchDaytonaClient({ apiToken: token }),
    (error) => error instanceof DaytonaError && error.code === 'CONFIGURATION' && /DAYTONA_API_URL/.test(error.message)
  );
  assert.throws(
    () => new FetchDaytonaClient({ apiUrl: 'https://daytona.test/api' }),
    (error) => error instanceof DaytonaError && error.code === 'CONFIGURATION' && /DAYTONA_API_TOKEN/.test(error.message)
  );
  assert.throws(
    () => new FetchDaytonaClient({ apiUrl: 'file:///tmp/daytona', apiToken: token }),
    (error) => error instanceof DaytonaError && error.code === 'CONFIGURATION' && !error.message.includes(token)
  );
});

test('Daytona provider runs the complete lifecycle through an injectable fake HTTP server', async (t) => {
  const host = await workspaceFixture();
  t.after(() => rm(host, { recursive: true, force: true }));
  const server = new FakeDaytonaServer();
  const client = new FetchDaytonaClient({
    apiUrl: 'https://daytona.test/api/',
    apiToken: token,
    fetchImpl: server.fetch.bind(server)
  });
  const provider = new DaytonaProvider({ client, clock: () => new Date(fixedTime) });
  const spec = {
    workspaceRoot: host,
    provider: 'daytona',
    command: 'opencode',
    commandArgs: ['--model', 'test model']
  };

  const handle = await provider.createRun(spec);
  assert.deepEqual(handle, { provider: 'daytona', id: server.sandboxId, createdAt: fixedTime });
  assert.equal(server.requests[0].path, '/api/sandboxes');
  assert.deepEqual(server.requests[0].body, {
    workspaceRoot: '/workspace/project',
    command: 'opencode',
    args: ['--model', 'test model']
  });
  assert.equal(JSON.stringify(server.requests[0].body).includes(host), false);

  await provider.uploadWorkspace(handle, host);
  const upload = server.requests[1];
  assert.equal(upload.path, `/api/sandboxes/${server.sandboxId}/workspace`);
  assert.equal(upload.body.root, '/workspace/project');
  assert.deepEqual(upload.body.entries.map((entry) => entry.path), ['input.txt', 'nested', 'nested/note.txt']);
  assert.equal(upload.body.entries.some((entry) => entry.path.startsWith('.env')), false);
  const uploadedFile = upload.body.entries.find((entry) => entry.path === 'input.txt');
  assert.equal(Buffer.from(uploadedFile.contentBase64, 'base64').toString(), 'original\n');

  const events = [];
  for await (const event of provider.execute(handle, 'opencode', ['--model', 'test model', 'quote"value', ''])) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['COMMAND_STARTED', 'COMMAND_EXITED']);
  assert.ok(events.every((event) => event.runId === handle.id));
  assert.deepEqual(server.requests[2].body.args, ['--model', 'test model', 'quote"value', '']);

  const manifest = await provider.collectWorkspace(handle);
  assert.deepEqual(manifest, server.manifest);
  assert.equal(server.requests[3].path, `/api/sandboxes/${server.sandboxId}/workspace/manifest`);

  await provider.destroy(handle);
  await provider.destroy(handle);
  assert.equal(server.requests.filter((request) => request.method === 'DELETE').length, 1);
  await assert.rejects(() => provider.collectWorkspace(handle), /not available/);
});

test('Daytona adapter keeps endpoint paths injectable while preserving array command arguments', async () => {
  const calls = [];
  const endpoints = {
    createSandbox: '/v1/create',
    uploadWorkspace: (id) => `/v1/${id}/upload`,
    execute: (id) => `/v1/${id}/run`,
    collectWorkspace: (id) => `/v1/${id}/manifest`,
    destroySandbox: (id) => `/v1/${id}`
  };
  const client = new FetchDaytonaClient({
    apiUrl: 'https://daytona.test/',
    apiToken: token,
    endpoints,
    fetchImpl: async (input, init) => {
      calls.push({ path: new URL(input).pathname, body: init.body && JSON.parse(init.body) });
      if (init.method === 'POST') {
        if (new URL(input).pathname === '/v1/create') return Response.json({ id: 'custom-id' });
        if (new URL(input).pathname === '/v1/custom-id/run') return Response.json({ events: [] });
        return Response.json({ accepted: true });
      }
      if (init.method === 'GET') return Response.json({
        root: '/workspace/project', createdAt: fixedTime, entries: [], hash: 'empty'
      });
      return new Response(null, { status: 204 });
    }
  });
  const created = await client.createSandbox({
    workspaceRoot: '/host/path with spaces',
    provider: 'daytona',
    command: 'node',
    commandArgs: ['-e', 'process.argv', 'argument with spaces']
  });
  assert.equal(created.id, 'custom-id');
  await client.execute(created.id, { command: 'node', args: ['a b', '"', ''], cwd: '/workspace/project' });
  assert.deepEqual(calls.map((call) => call.path), ['/v1/create', '/v1/custom-id/run']);
  assert.deepEqual(calls[1].body.args, ['a b', '"', '']);
  assert.deepEqual(DEFAULT_DAYTONA_ENDPOINTS.uploadWorkspace('id with slash'), '/sandboxes/id%20with%20slash/workspace');
});

test('Daytona HTTP failures do not echo the bearer token', async () => {
  const client = new FetchDaytonaClient({
    apiUrl: 'https://daytona.test/',
    apiToken: token,
    fetchImpl: async () => new Response(`upstream body accidentally mentioned ${token}`, { status: 503 })
  });
  await assert.rejects(
    () => client.collectWorkspace('sandbox-test-1'),
    (error) => error instanceof DaytonaError && error.code === 'HTTP' && !error.message.includes(token)
  );
});
