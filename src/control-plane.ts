import { createHash, randomUUID } from 'node:crypto';
import type {
  CapabilityLease,
  LeaseOperation,
  RuntimeEvent,
  RunSpec,
  SandboxHandle,
  SandboxProvider,
  WorkspaceManifest
} from './core/contracts.js';

export type RunState = 'created' | 'uploaded' | 'executing' | 'executed' | 'collected' | 'revoked' | 'destroyed' | 'rolled_back';

export interface ControlRun {
  readonly id: string;
  readonly spec: RunSpec;
  readonly handle: SandboxHandle;
  readonly createdAt: string;
  readonly state: RunState;
  readonly lease?: CapabilityLease;
  readonly manifest?: WorkspaceManifest;
}

export interface LeaseRequest {
  readonly operations: readonly LeaseOperation[];
  readonly allowedDomains: readonly string[];
  readonly expiresAt: string;
}

export interface ControlPlaneOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export type ControlPlaneErrorCode =
  | 'RUN_NOT_FOUND'
  | 'LEASE_NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_LEASE'
  | 'LEASE_EXPIRED'
  | 'LEASE_REVOKED';

export class ControlPlaneError extends Error {
  constructor(readonly code: ControlPlaneErrorCode, message: string) {
    super(`control plane ${code.toLowerCase()}: ${message}`);
    this.name = 'ControlPlaneError';
  }
}

const knownLeaseOperations = new Set<LeaseOperation>([
  'workspace.list',
  'workspace.read',
  'workspace.write',
  'workspace.stat',
  'workspace.diff',
  'promotion.submit',
  'run.status'
]);

const sensitiveKey = /(?:api[-_ ]?key|access[-_ ]?token|authorization|bearer|cookie|credential|password|private[-_ ]?key|refresh[-_ ]?token|secret|token)/i;
const credentialPattern = /(?:bearer|basic)\s+(?!\[REDACTED\])[^\s,;]+|(?:api[-_ ]?key|access[-_ ]?token|password|secret|token)\s*[:=]\s*(?!\[REDACTED\])[^\s,;]+|\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9._-]+\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi;

interface MutableRun {
  readonly id: string;
  readonly spec: RunSpec;
  readonly handle: SandboxHandle;
  readonly createdAt: string;
  state: RunState;
  lease?: CapabilityLease;
  leaseRevoked: boolean;
  manifest?: WorkspaceManifest;
  readonly evidence: RuntimeEvent[];
}

/** Provider-neutral lifecycle orchestration with a local, tamper-evident evidence stream. */
export class ControlPlane {
  private readonly runs = new Map<string, MutableRun>();
  private readonly leases = new Map<string, CapabilityLease>();
  private readonly provider: SandboxProvider;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(provider: SandboxProvider, options: ControlPlaneOptions = {}) {
    this.provider = provider;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async createRun(spec: RunSpec): Promise<ControlRun> {
    validateRunSpec(spec);
    const handle = await this.provider.createRun(spec);
    const id = `run_${this.idFactory()}`;
    const run: MutableRun = {
      id,
      spec: { ...spec, commandArgs: [...spec.commandArgs] },
      handle,
      createdAt: this.clock().toISOString(),
      state: 'created',
      leaseRevoked: false,
      evidence: []
    };
    this.runs.set(id, run);
    this.append(run, 'RUN_CREATED', { sandboxId: handle.id, provider: handle.provider });
    this.append(run, 'SANDBOX_CREATED', { sandboxId: handle.id, provider: handle.provider });
    return this.snapshot(run);
  }

  async uploadWorkspace(runId: string, source?: string): Promise<ControlRun> {
    const run = this.activeRun(runId);
    this.requireState(run, ['created']);
    await this.provider.uploadWorkspace(run.handle, source ?? run.spec.workspaceRoot);
    run.state = 'uploaded';
    return this.snapshot(run);
  }

  async execute(runId: string, command?: string, args?: readonly string[]): Promise<readonly RuntimeEvent[]> {
    const run = this.activeRun(runId);
    this.requireState(run, ['uploaded']);
    const selectedCommand = command ?? run.spec.command;
    const selectedArgs = args ?? run.spec.commandArgs;
    if (!selectedCommand.trim()) throw new ControlPlaneError('INVALID_STATE', 'command is required');
    if (!Array.isArray(selectedArgs) || selectedArgs.some((argument) => typeof argument !== 'string')) {
      throw new ControlPlaneError('INVALID_STATE', 'command args must be an array of strings');
    }

    run.state = 'executing';
    const collected: RuntimeEvent[] = [];
    try {
      for await (const event of this.provider.execute(run.handle, selectedCommand, selectedArgs)) {
        const recorded = this.append(run, event.type, {
          sandboxId: run.handle.id,
          ...redactPayload(event.payload)
        });
        collected.push(recorded);
      }
      run.state = 'executed';
      return collected;
    } catch (error) {
      run.state = 'executed';
      throw error;
    }
  }

  async collect(runId: string): Promise<WorkspaceManifest> {
    const run = this.activeRun(runId);
    this.requireState(run, ['executed', 'collected']);
    const manifest = await this.provider.collectWorkspace(run.handle);
    run.manifest = manifest;
    run.state = 'collected';
    return manifest;
  }

  async destroy(runId: string): Promise<ControlRun> {
    const run = this.run(runId);
    if (run.state === 'destroyed' || run.state === 'rolled_back') return this.snapshot(run);
    if (run.state === 'executing') throw new ControlPlaneError('INVALID_STATE', 'cannot destroy an executing run');
    await this.provider.destroy(run.handle);
    run.state = 'destroyed';
    this.append(run, 'SANDBOX_DESTROYED', { sandboxId: run.handle.id });
    return this.snapshot(run);
  }

  createLease(runId: string, request: LeaseRequest): CapabilityLease {
    const run = this.activeRun(runId);
    if (run.state === 'destroyed' || run.state === 'rolled_back' || run.leaseRevoked) {
      throw new ControlPlaneError('INVALID_STATE', 'cannot grant a lease for an inactive run');
    }
    const operations = normalizeOperations(request.operations);
    const allowedDomains = normalizeStrings(request.allowedDomains);
    const expiresAt = parseExpiry(request.expiresAt, this.clock());
    if (operations.length === 0) throw new ControlPlaneError('INVALID_LEASE', 'at least one operation is required');
    if (expiresAt <= this.clock().getTime()) throw new ControlPlaneError('LEASE_EXPIRED', 'lease must expire in the future');

    const lease: CapabilityLease = {
      id: `lease_${this.idFactory()}`,
      runId,
      sandboxId: run.handle.id,
      workspaceRoot: run.spec.workspaceRoot,
      operations,
      allowedDomains,
      expiresAt: new Date(expiresAt).toISOString(),
      policyHash: policyHash({
        runId,
        sandboxId: run.handle.id,
        workspaceRoot: run.spec.workspaceRoot,
        operations,
        allowedDomains,
        expiresAt: new Date(expiresAt).toISOString()
      })
    };
    run.lease = lease;
    run.leaseRevoked = false;
    this.leases.set(lease.id, lease);
    this.append(run, 'LEASE_GRANTED', {
      leaseId: lease.id,
      sandboxId: lease.sandboxId,
      policyHash: lease.policyHash,
      expiresAt: lease.expiresAt
    });
    return lease;
  }

  validateLease(lease: CapabilityLease, runId = lease.runId): true {
    const run = this.run(runId);
    if (lease.runId !== run.id || lease.sandboxId !== run.handle.id) {
      throw new ControlPlaneError('INVALID_LEASE', 'lease is not scoped to this run');
    }
    if (run.leaseRevoked) throw new ControlPlaneError('LEASE_REVOKED', 'lease has been revoked');
    const issued = this.leases.get(lease.id);
    if (!issued || run.lease?.id !== lease.id || issued.runId !== lease.runId) {
      throw new ControlPlaneError('INVALID_LEASE', 'lease is not issued for this run');
    }
    const expiresAt = parseExpiry(lease.expiresAt, this.clock());
    if (expiresAt <= this.clock().getTime()) throw new ControlPlaneError('LEASE_EXPIRED', 'lease has expired');
    const expected = policyHash({
      runId: lease.runId,
      sandboxId: lease.sandboxId,
      workspaceRoot: lease.workspaceRoot,
      operations: normalizeOperations(lease.operations),
      allowedDomains: normalizeStrings(lease.allowedDomains),
      expiresAt: new Date(expiresAt).toISOString()
    });
    if (lease.policyHash !== expected) throw new ControlPlaneError('INVALID_LEASE', 'lease policy hash does not match its policy');
    return true;
  }

  revoke(runId: string): ControlRun {
    const run = this.run(runId);
    if (run.state === 'destroyed' || run.state === 'rolled_back') {
      throw new ControlPlaneError('INVALID_STATE', 'cannot revoke an inactive run');
    }
    if (!run.leaseRevoked) {
      run.leaseRevoked = true;
      run.state = 'revoked';
      this.append(run, 'LEASE_REVOKED', { leaseId: run.lease?.id ?? '[none]' });
    }
    return this.snapshot(run);
  }

  async rollback(runId: string): Promise<ControlRun> {
    const run = this.run(runId);
    if (run.state === 'rolled_back') return this.snapshot(run);
    if (run.state === 'executing') throw new ControlPlaneError('INVALID_STATE', 'cannot roll back an executing run');
    if (!run.leaseRevoked) {
      run.leaseRevoked = true;
      this.append(run, 'LEASE_REVOKED', { leaseId: run.lease?.id ?? '[none]' });
    }
    if (run.state !== 'destroyed') {
      await this.provider.destroy(run.handle);
      run.state = 'destroyed';
      this.append(run, 'SANDBOX_DESTROYED', { sandboxId: run.handle.id });
    }
    run.state = 'rolled_back';
    this.append(run, 'ROLLBACK_COMPLETED', { sandboxId: run.handle.id });
    return this.snapshot(run);
  }

  revokeLease(runId: string): ControlRun {
    return this.revoke(runId);
  }

  rollbackRun(runId: string): Promise<ControlRun> {
    return this.rollback(runId);
  }

  getRun(runId: string): ControlRun {
    return this.snapshot(this.run(runId));
  }

  evidence(runId: string): readonly RuntimeEvent[] {
    return this.run(runId).evidence.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  events(runId: string): readonly RuntimeEvent[] {
    return this.evidence(runId);
  }

  verifyEvidence(runId: string, records = this.evidence(runId)): boolean {
    const run = this.run(runId);
    let previousHash: string | null = null;
    for (const record of records) {
      if (record.runId !== run.id || record.previousHash !== previousHash) return false;
      if (JSON.stringify(record.payload) !== JSON.stringify(redactPayload(record.payload))) return false;
      if (record.hash !== hashEvent(record)) return false;
      previousHash = record.hash;
    }
    return true;
  }

  private activeRun(runId: string): MutableRun {
    const run = this.run(runId);
    if (run.state === 'revoked') throw new ControlPlaneError('LEASE_REVOKED', 'run has been revoked');
    if (run.state === 'destroyed' || run.state === 'rolled_back') throw new ControlPlaneError('INVALID_STATE', 'run is inactive');
    return run;
  }

  private run(runId: string): MutableRun {
    const run = this.runs.get(runId);
    if (!run) throw new ControlPlaneError('RUN_NOT_FOUND', `run ${runId} was not found`);
    return run;
  }

  private requireState(run: MutableRun, allowed: readonly RunState[]): void {
    if (!allowed.includes(run.state)) {
      throw new ControlPlaneError('INVALID_STATE', `run is ${run.state}; expected ${allowed.join(' or ')}`);
    }
  }

  private append(run: MutableRun, type: RuntimeEvent['type'], payload: Record<string, string | number | boolean>): RuntimeEvent {
    const event: RuntimeEvent = {
      id: `event_${this.idFactory()}`,
      type,
      runId: run.id,
      occurredAt: this.clock().toISOString(),
      payload: redactPayload(payload),
      previousHash: run.evidence.at(-1)?.hash ?? null,
      hash: ''
    };
    const chained = { ...event, hash: hashEvent(event) };
    run.evidence.push(chained);
    return chained;
  }

  private snapshot(run: MutableRun): ControlRun {
    return {
      id: run.id,
      spec: { ...run.spec, commandArgs: [...run.spec.commandArgs] },
      handle: { ...run.handle },
      createdAt: run.createdAt,
      state: run.state,
      ...(run.lease ? { lease: { ...run.lease, operations: [...run.lease.operations], allowedDomains: [...run.lease.allowedDomains] } } : {}),
      ...(run.manifest ? { manifest: run.manifest } : {})
    };
  }
}

export function hashEvent(event: Omit<RuntimeEvent, 'hash'>): string {
  return `sha256:${createHash('sha256').update(canonicalize({
    id: event.id,
    type: event.type,
    runId: event.runId,
    occurredAt: event.occurredAt,
    payload: event.payload,
    previousHash: event.previousHash
  })).digest('hex')}`;
}

export function policyHash(policy: Omit<CapabilityLease, 'id' | 'policyHash'>): string {
  return `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}`;
}

function validateRunSpec(spec: RunSpec): void {
  if (!spec.workspaceRoot.trim()) throw new ControlPlaneError('INVALID_STATE', 'workspaceRoot is required');
  if (!spec.command.trim()) throw new ControlPlaneError('INVALID_STATE', 'command is required');
  if (!Array.isArray(spec.commandArgs) || spec.commandArgs.some((argument) => typeof argument !== 'string')) {
    throw new ControlPlaneError('INVALID_STATE', 'commandArgs must be an array of strings');
  }
}

function normalizeOperations(operations: readonly LeaseOperation[]): LeaseOperation[] {
  const values = [...new Set(operations)];
  const invalid = values.find((operation) => !knownLeaseOperations.has(operation));
  if (invalid !== undefined) throw new ControlPlaneError('INVALID_LEASE', `unknown operation ${invalid}`);
  return values.sort();
}

function normalizeStrings(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new ControlPlaneError('INVALID_LEASE', 'policy values must be arrays of strings');
  }
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function parseExpiry(value: string, now: Date): number {
  if (typeof value !== 'string' || !value.trim()) throw new ControlPlaneError('INVALID_LEASE', 'expiresAt is required');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ControlPlaneError('INVALID_LEASE', 'expiresAt must be a valid timestamp');
  if (parsed <= now.getTime()) throw new ControlPlaneError('LEASE_EXPIRED', 'lease has expired');
  return parsed;
}

function redactPayload(payload: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const redacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (sensitiveKey.test(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      redacted[key] = value.replaceAll(credentialPattern, '[REDACTED]');
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      redacted[key] = value;
    } else {
      redacted[key] = '[REDACTED]';
    }
  }
  return redacted;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
