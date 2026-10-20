import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  GatewayError,
  InMemoryCredentialResolver,
  ZkEgressGateway
} from '../dist/gateway.js';

async function localServer() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function gatewayFor(origin, events) {
  const gateway = new ZkEgressGateway({
    credentialResolver: new InMemoryCredentialResolver({ service: 'real-secret-value' }),
    onEvent: (event) => events.push(event),
    clock: () => new Date('2026-10-20T00:00:00.000Z')
  });
  gateway.registerRoute({
    runId: 'run-1',
    leaseId: 'lease-1',
    placeholder: 'zk://run-1/service',
    credentialName: 'service',
    domains: [new URL(origin).hostname],
    methods: ['POST'],
    paths: ['/v1/allowed']
  });
  return gateway;
}

async function assertBlocked(gateway, request, code, secret = 'real-secret-value') {
  await assert.rejects(
    () => gateway.forward(request),
    (error) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
}

test('forwards only an allowed request and injects the real credential at egress', async (t) => {
  const fixture = await localServer();
  t.after(() => fixture.close());
  const events = [];
  const gateway = gatewayFor(fixture.origin, events);

  const response = await gateway.forward({
    runId: 'run-1',
    leaseId: 'lease-1',
    credentialPlaceholder: 'zk://run-1/service',
    url: `${fixture.origin}/v1/allowed`,
    method: 'post',
    headers: { 'content-type': 'text/plain' },
    body: 'payload'
  });

  assert.equal(response.status, 200);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].method, 'POST');
  assert.equal(fixture.requests[0].url, '/v1/allowed');
  assert.equal(fixture.requests[0].authorization, 'Bearer real-secret-value');
  assert.equal(fixture.requests[0].headers['x-credential-placeholder'], undefined);
  assert.equal(fixture.requests[0].body, 'payload');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'EGRESS_ALLOWED');
  assert.equal(events[0].runId, 'run-1');
  assert.equal(events[0].leaseId, 'lease-1');
  assert.equal(JSON.stringify(events), JSON.stringify(events).replaceAll('real-secret-value', '[redacted]'));

  const diagnostics = gateway.diagnostics();
  assert.equal(JSON.stringify(diagnostics).includes('real-secret-value'), false);
  assert.equal(diagnostics.routes[0].placeholder, '[REDACTED]');
});

test('rejects wrong run, lease, destination, method, and path before forwarding', async (t) => {
  const fixture = await localServer();
  t.after(() => fixture.close());
  const events = [];
  const gateway = gatewayFor(fixture.origin, events);
  const baseRequest = {
    runId: 'run-1',
    leaseId: 'lease-1',
    credentialPlaceholder: 'zk://run-1/service',
    url: `${fixture.origin}/v1/allowed`,
    method: 'POST'
  };

  await assertBlocked(gateway, { ...baseRequest, runId: 'run-2' }, 'RUN_MISMATCH');
  await assertBlocked(gateway, { ...baseRequest, leaseId: 'lease-2' }, 'LEASE_MISMATCH');
  await assertBlocked(gateway, { ...baseRequest, url: 'http://localhost:9/v1/allowed' }, 'DESTINATION_NOT_ALLOWED');
  await assertBlocked(gateway, { ...baseRequest, method: 'GET' }, 'METHOD_NOT_ALLOWED');
  await assertBlocked(gateway, { ...baseRequest, url: `${fixture.origin}/v1/other` }, 'PATH_NOT_ALLOWED');

  assert.equal(fixture.requests.length, 0);
  assert.equal(events.every((event) => event.type === 'EGRESS_BLOCKED'), true);
  assert.equal(events.some((event) => JSON.stringify(event).includes('real-secret-value')), false);
  assert.equal(gateway.diagnostics().blockedCount, 5);
});

test('does not expose unknown placeholders or unresolved credentials', async (t) => {
  const fixture = await localServer();
  t.after(() => fixture.close());
  const events = [];
  const gateway = gatewayFor(fixture.origin, events);

  await assertBlocked(gateway, {
    runId: 'run-1',
    leaseId: 'lease-1',
    credentialPlaceholder: 'zk://run-1/unknown',
    url: `${fixture.origin}/v1/allowed`,
    method: 'POST'
  }, 'PLACEHOLDER_UNKNOWN');

  const unresolved = new ZkEgressGateway({
    credentialResolver: new InMemoryCredentialResolver({}),
    onEvent: (event) => events.push(event)
  });
  unresolved.registerRoute({
    runId: 'run-1',
    leaseId: 'lease-1',
    placeholder: 'zk://run-1/missing',
    credentialName: 'missing',
    domains: [new URL(fixture.origin).hostname],
    methods: ['POST'],
    paths: ['/v1/allowed']
  });

  await assertBlocked(unresolved, {
    runId: 'run-1',
    leaseId: 'lease-1',
    credentialPlaceholder: 'zk://run-1/missing',
    url: `${fixture.origin}/v1/allowed`,
    method: 'POST'
  }, 'CREDENTIAL_RESOLUTION_FAILED');
  assert.equal(fixture.requests.length, 0);
});
