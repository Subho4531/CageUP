import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlane, ControlPlaneError, hashEvent } from '../dist/control-plane.js';

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
    yield {
      id: 'provider-event-1',
      type: 'COMMAND_STARTED',
      runId: handle.id,
      occurredAt: fixedTime,
      payload: { command, apiKey: 'real-secret-value', message: 'Bearer real-secret-value', argumentCount: args.length },
      previousHash: null,
      hash: 'provider-hash-is-not-trusted'
    };
    yield {
      id: 'provider-event-2',
      type: 'COMMAND_EXITED',
      runId: handle.id,
      occurredAt: fixedTime,
      payload: { exitCode: 0 },
      previousHash: null,
      hash: 'another-provider-hash'
    };
  }

  async collectWorkspace(handle) {
    this.calls.push(['collectWorkspace', handle.id]);
    return {
      root: '/workspace/project',
      createdAt: fixedTime,
      entries: [{ path: 'result.txt', kind: 'file', size: 7, sha256: 'result-hash' }],
      hash: 'manifest-hash'
    };
  }

  async destroy(handle) {
    this.calls.push(['destroy', handle.id]);
  }
}

function makePlane(provider = new FakeProvider()) {
  return {
    provider,
    plane: new ControlPlane(provider, {
      clock: () => new Date(fixedTime),
      idFactory: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })()
    })
  };
}

async function createRun(plane) {
  return plane.createRun({
    workspaceRoot: '/host/project',
    provider: 'simulator',
    command: 'opencode',
    commandArgs: ['--model', 'test-model']
  });
}

function leaseRequest(expiresAt = '2026-10-20T01:00:00.000Z') {
  return {
    operations: ['workspace.read', 'workspace.write', 'run.status'],
    allowedDomains: ['api.example.com'],
    expiresAt
  };
}

test('orchestrates the provider lifecycle and forwards the RunSpec command by default', async () => {
  const { plane, provider } = makePlane();
  const run = await createRun(plane);
  assert.equal(run.state, 'created');

  await plane.uploadWorkspace(run.id);
  const events = await plane.execute(run.id);
  const manifest = await plane.collect(run.id);
  const destroyed = await plane.destroy(run.id);

  assert.deepEqual(events.map((event) => event.type), ['COMMAND_STARTED', 'COMMAND_EXITED']);
  assert.equal(manifest.hash, 'manifest-hash');
  assert.equal(destroyed.state, 'destroyed');
  assert.deepEqual(provider.calls.map(([name]) => name), [
    'createRun',
    'uploadWorkspace',
    'execute',
    'collectWorkspace',
    'destroy'
  ]);
  assert.deepEqual(provider.calls[2], ['execute', 'sandbox-1', 'opencode', ['--model', 'test-model']]);
});

test('creates and validates a run-scoped, expiring lease with a policy hash', async () => {
  const { plane } = makePlane();
  const run = await createRun(plane);
  const lease = plane.createLease(run.id, leaseRequest());

  assert.equal(plane.validateLease(lease), true);
  assert.equal(plane.validateLease(plane.getRun(run.id).lease), true);
  assert.match(lease.policyHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lease.runId, run.id);
  assert.equal(lease.sandboxId, run.handle.id);
  assert.deepEqual(lease.operations, ['run.status', 'workspace.read', 'workspace.write']);

  const tampered = { ...lease, allowedDomains: ['evil.example.com'] };
  assert.throws(() => plane.validateLease(tampered), (error) => {
    return error instanceof ControlPlaneError && error.code === 'INVALID_LEASE';
  });
  assert.throws(() => plane.createLease(run.id, leaseRequest(fixedTime)), (error) => {
    return error instanceof ControlPlaneError && error.code === 'LEASE_EXPIRED';
  });
});

test('redacts credential-like event payloads and maintains a verifiable hash chain', async () => {
  const { plane } = makePlane();
  const run = await createRun(plane);
  await plane.uploadWorkspace(run.id);
  await plane.execute(run.id);

  const evidence = plane.evidence(run.id);
  assert.ok(evidence.length >= 4);
  assert.equal(evidence[0].previousHash, null);
  for (let index = 1; index < evidence.length; index += 1) {
    assert.equal(evidence[index].previousHash, evidence[index - 1].hash);
  }
  assert.equal(plane.verifyEvidence(run.id), true);
  assert.equal(JSON.stringify(evidence).includes('real-secret-value'), false);
  assert.equal(evidence.find((event) => event.type === 'COMMAND_STARTED').payload.apiKey, '[REDACTED]');
  assert.equal(evidence.find((event) => event.type === 'COMMAND_STARTED').payload.message, '[REDACTED]');

  const tampered = evidence.map((event) => ({ ...event, payload: { ...event.payload } }));
  tampered[1].payload.provider = 'tampered';
  assert.equal(plane.verifyEvidence(run.id, tampered), false);
  assert.equal(hashEvent(evidence[0]), evidence[0].hash);
});

test('revoke blocks further lifecycle work and rollback destroys the sandbox', async () => {
  const { plane, provider } = makePlane();
  const run = await createRun(plane);
  plane.createLease(run.id, leaseRequest());

  const revoked = plane.revoke(run.id);
  assert.equal(revoked.state, 'revoked');
  assert.throws(() => plane.validateLease(revoked.lease), (error) => {
    return error instanceof ControlPlaneError && error.code === 'LEASE_REVOKED';
  });
  await assert.rejects(() => plane.uploadWorkspace(run.id), (error) => {
    return error instanceof ControlPlaneError && error.code === 'LEASE_REVOKED';
  });

  const second = await createRun(plane);
  const rolledBack = await plane.rollback(second.id);
  assert.equal(rolledBack.state, 'rolled_back');
  assert.deepEqual(provider.calls.filter(([name]) => name === 'destroy'), [['destroy', 'sandbox-2']]);
  assert.deepEqual(plane.evidence(second.id).slice(-3).map((event) => event.type), [
    'LEASE_REVOKED',
    'SANDBOX_DESTROYED',
    'ROLLBACK_COMPLETED'
  ]);
});
