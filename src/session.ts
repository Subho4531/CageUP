import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ControlPlane,
  type ControlPlaneOptions,
  type ControlRun,
  type LeaseRequest,
  policyHash,
  type RunState
} from './control-plane.js';
import { CageBridge } from './bridge.js';
import type {
  CapabilityLease,
  FileManifestEntry,
  LeaseOperation,
  ProviderName,
  PromotionDecision,
  RunSpec,
  RuntimeEvent,
  SandboxHandle,
  SandboxProvider,
  WorkspaceManifest
} from './core/contracts.js';
import { SimulatorProvider } from './providers/simulator.js';
import { DaytonaProvider } from './providers/daytona.js';
import {
  classifyPromotionPath,
  createPromotionPlan,
  promotePromotion,
  rollbackPromotion,
  stagePromotion,
  type PromotionChange,
  type PromotionReceipt,
  type ReviewedPromotionDecision
} from './promotion.js';

export type SessionState = 'starting' | RunState | 'failed';
export type SessionRuntimeAvailability = 'in-process-only' | 'destroyed' | 'unknown';

export interface SessionLeaseRequest extends Omit<LeaseRequest, 'operations' | 'allowedDomains' | 'expiresAt'> {
  readonly operations?: readonly LeaseOperation[];
  readonly allowedDomains?: readonly string[];
  readonly expiresAt?: string;
}

export interface SessionStartRequest extends RunSpec {
  readonly lease?: SessionLeaseRequest;
}

export interface PersistedSessionSpec extends RunSpec {
  /** Sensitive-looking argument values are replaced before persistence. */
  readonly commandArgs: readonly string[];
}

export interface SessionErrorInfo {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface SessionRuntimeInfo {
  readonly provider: ProviderName;
  readonly sandboxId?: string;
  readonly availability: SessionRuntimeAvailability;
}

export interface SessionReview {
  readonly reviewedAt: string;
  readonly decisions: readonly (PromotionDecision & { readonly reviewed: boolean })[];
}

export interface SessionPromotion {
  readonly status: 'promoted' | 'rolled_back';
  readonly updatedAt: string;
  readonly receipt: PromotionReceipt;
}

export interface SessionRecord {
  readonly version: 1;
  readonly id: string;
  readonly runId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: SessionState;
  readonly spec: PersistedSessionSpec;
  readonly runtime: SessionRuntimeInfo;
  readonly handle?: SandboxHandle;
  readonly lease?: CapabilityLease;
  readonly baseline?: WorkspaceManifest;
  readonly result?: WorkspaceManifest;
  readonly resultRoot?: string;
  readonly evidence: readonly RuntimeEvent[];
  readonly review?: SessionReview;
  readonly promotion?: SessionPromotion;
  readonly error?: SessionErrorInfo;
  readonly cleanupError?: SessionErrorInfo;
}

export interface SessionStatus extends SessionRecord {
  readonly runtimeAvailable: boolean;
}

export interface SessionPolicy {
  readonly sessionId: string;
  readonly runId?: string;
  readonly sandboxId?: string;
  readonly workspaceRoot: string;
  readonly operations: readonly LeaseOperation[];
  readonly allowedDomains: readonly string[];
  readonly expiresAt?: string;
  readonly policyHash?: string;
}

export type SessionCommandRunner = (
  provider: SandboxProvider,
  handle: SandboxHandle,
  command: string,
  args: readonly string[]
) => AsyncIterable<RuntimeEvent> | Iterable<RuntimeEvent>;

export type SessionProviderFactory = (
  provider: ProviderName,
  request: SessionStartRequest
) => SandboxProvider;

type ExportingSandboxProvider = SandboxProvider & {
  readonly exportWorkspace?: (handle: SandboxHandle, destination: string) => Promise<void>;
};

export interface SessionRuntimeOptions {
  /** State is written below this directory, never below the selected workspace. */
  readonly stateDir?: string;
  readonly providerFactory?: SessionProviderFactory;
  readonly commandRunner?: SessionCommandRunner;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export type SessionErrorCode =
  | 'INVALID_REQUEST'
  | 'STATE_DIRECTORY_UNSAFE'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_RECORD'
  | 'RECOVERY_UNAVAILABLE'
  | 'INVALID_STATE'
  | 'START_FAILED'
  | 'STATE_IO';

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions
  ) {
    super(`session ${code.toLowerCase()}: ${message}`, options);
    this.name = 'SessionError';
  }
}

export class SessionRecoveryError extends SessionError {
  constructor(sessionId: string, message: string) {
    super('RECOVERY_UNAVAILABLE', message, sessionId);
    this.name = 'SessionRecoveryError';
  }
}

interface RuntimeContext {
  readonly plane: ControlPlane;
  readonly handle: SandboxHandle;
}

const CURRENT_VERSION = 1 as const;
const DEFAULT_OPERATIONS: readonly LeaseOperation[] = [
  'workspace.list',
  'workspace.read',
  'workspace.write',
  'workspace.stat',
  'workspace.diff',
  'promotion.submit',
  'run.status'
];
const SENSITIVE_ARGUMENT = /(?:api[-_ ]?key|access[-_ ]?token|authorization|auth|bearer|cookie|credential|password|private[-_ ]?key|refresh[-_ ]?token|secret|token)/i;
const HEADER_ARGUMENT = /^(?:-H|--header)$/i;
const CREDENTIAL_VALUE = /(?:\b(?:basic|bearer)\s+(?!\[REDACTED\])[^\s,;]+|(?:authorization|cookie)\s*:\s*(?!\[REDACTED\])[^\r\n,;]+|\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9._-]+\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/i;
const SENSITIVE_FIELD = /(?:authorization|cookie|password|private[-_ ]?key|refresh[-_ ]?token|secret|access[-_ ]?token|api[-_ ]?key)/i;

/** Persistent local orchestration for one-shot provider sessions. */
export class SessionRuntime {
  private stateDir: string;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly providerFactory: SessionProviderFactory;
  private readonly commandRunner: SessionCommandRunner | undefined;
  private readonly runtimes = new Map<string, RuntimeContext>();

  constructor(options: SessionRuntimeOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? join(homedir(), '.cageup'));
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.providerFactory = options.providerFactory ?? ((provider) => {
      if (provider === 'simulator') return new SimulatorProvider({ clock: this.clock });
      const daytonaOptions: { clock: () => Date; apiUrl?: string; apiToken?: string } = { clock: this.clock };
      if (process.env.DAYTONA_API_URL) daytonaOptions.apiUrl = process.env.DAYTONA_API_URL;
      if (process.env.DAYTONA_API_TOKEN) daytonaOptions.apiToken = process.env.DAYTONA_API_TOKEN;
      return new DaytonaProvider(daytonaOptions);
    });
    this.commandRunner = options.commandRunner;
  }

  async start(request: SessionStartRequest): Promise<SessionRecord> {
    validateStartRequest(request);
    await this.assertStateDirOutsideWorkspace(request.workspaceRoot);

    const sessionId = `session_${this.idFactory()}`;
    const now = this.clock().toISOString();
    let record: SessionRecord = {
      version: CURRENT_VERSION,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      state: 'starting',
      spec: persistedSpec(request),
      runtime: { provider: request.provider, availability: 'in-process-only' },
      evidence: []
    };
    await this.save(record);

    let plane: ControlPlane | undefined;
    let executionProvider: SandboxProvider | undefined;
    let createdHandle: SandboxHandle | undefined;
    try {
      const provider = this.providerFactory(request.provider, request);
      executionProvider = this.withCommandRunner(provider);
      const controlPlaneOptions: ControlPlaneOptions = { clock: this.clock, idFactory: this.idFactory };
      plane = new ControlPlane(executionProvider, controlPlaneOptions);
      const created = await plane.createRun(request);
      createdHandle = created.handle;
      this.runtimes.set(sessionId, { plane, handle: created.handle });
      record = this.fromControlRun(record, created, plane.evidence(created.id));
      await this.save(record);

      await plane.uploadWorkspace(created.id, request.workspaceRoot);
      record = this.fromControlRun(record, plane.getRun(created.id), plane.evidence(created.id));
      await this.save(record);

      const lease = plane.createLease(created.id, this.leaseRequest(request.lease));
      record = this.fromControlRun(record, plane.getRun(created.id), plane.evidence(created.id));
      await this.save(record);

      if (lease.operations.includes('workspace.list')) {
        record = { ...record, baseline: await captureBaseline(lease, this.clock) };
        await this.save(record);
      }

      record = { ...record, state: 'executing', updatedAt: this.clock().toISOString() };
      await this.save(record);
      await plane.execute(created.id, request.command, [...request.commandArgs]);
      record = this.fromControlRun(record, plane.getRun(created.id), plane.evidence(created.id));
      await this.save(record);

      const result = await plane.collect(created.id);
      record = this.fromControlRun(record, plane.getRun(created.id), plane.evidence(created.id));
      const resultRoot = await this.exportResult(executionProvider, created.handle, sessionId);
      record = { ...record, result, ...(resultRoot ? { resultRoot } : {}), updatedAt: this.clock().toISOString() };
      await this.save(record);

      return clone(record);
    } catch (error) {
      const safeError = errorInfo(error);
      let cleanupError: SessionErrorInfo | undefined;
      let cleanupSucceeded = false;
      if (plane && record.runId) {
        const runId = record.runId;
        try {
          const rolledBack = await plane.rollback(runId);
          record = this.fromControlRun(record, rolledBack, plane.evidence(runId));
          cleanupSucceeded = true;
        } catch (cleanupFailure) {
          cleanupError = errorInfo(cleanupFailure);
          try {
            const controlRun = plane.getRun(runId);
            record = this.fromControlRun(record, controlRun, plane.evidence(runId));
          } catch {
            // Keep the original start failure and the safely-redacted cleanup failure.
          }
        }
      } else if (executionProvider && createdHandle) {
        try {
          await executionProvider.destroy(createdHandle);
          cleanupSucceeded = true;
        } catch (cleanupFailure) {
          cleanupError = errorInfo(cleanupFailure);
        }
      }
      this.runtimes.delete(sessionId);
      record = {
        ...record,
        state: 'failed',
        updatedAt: this.clock().toISOString(),
        error: safeError,
        runtime: { ...record.runtime, availability: cleanupSucceeded ? 'destroyed' : (createdHandle ? 'unknown' : record.runtime.availability) },
        ...(cleanupError ? { cleanupError } : {})
      };
      await this.save(record).catch(() => undefined);
      throw new SessionError('START_FAILED', safeError.message, sessionId, { cause: error });
    }
  }

  async load(sessionId: string): Promise<SessionRecord> {
    await this.canonicalizeStateDir();
    const path = await this.safeStatePath(this.filePath(sessionId), undefined, 'session state path');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new SessionError('SESSION_NOT_FOUND', `session ${sessionId} was not found`, sessionId);
      throw new SessionError('STATE_IO', `could not read ${path}`, sessionId, { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new SessionError('INVALID_RECORD', `session ${sessionId} is not valid JSON`, sessionId, { cause: error });
    }
    const record = parseSessionRecord(value, sessionId);
    await this.assertStateDirOutsideWorkspace(record.spec.workspaceRoot);
    return record;
  }

  async status(sessionId: string): Promise<SessionStatus> {
    const record = await this.load(sessionId);
    return { ...record, runtimeAvailable: this.runtimes.has(sessionId) };
  }

  async policy(sessionId: string): Promise<SessionPolicy> {
    const record = await this.load(sessionId);
    return {
      sessionId: record.id,
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.handle ? { sandboxId: record.handle.id } : {}),
      workspaceRoot: record.spec.workspaceRoot,
      operations: record.lease ? [...record.lease.operations] : [],
      allowedDomains: record.lease ? [...record.lease.allowedDomains] : [],
      ...(record.lease ? { expiresAt: record.lease.expiresAt, policyHash: record.lease.policyHash } : {})
    };
  }

  async evidence(sessionId: string): Promise<readonly RuntimeEvent[]> {
    const record = await this.load(sessionId);
    return record.evidence.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  async diff(sessionId: string): Promise<readonly PromotionChange[]> {
    const record = await this.load(sessionId);
    return manifestDiff(record.baseline, record.result);
  }

  async review(sessionId: string): Promise<SessionReview> {
    const record = await this.load(sessionId);
    const decisions = manifestDiff(record.baseline, record.result).map((change) => reviewChange(change));
    const review: SessionReview = {
      reviewedAt: this.clock().toISOString(),
      decisions: decisions.map((decision) => ({ ...decision, reviewed: false }))
    };
    await this.save({ ...record, review, updatedAt: this.clock().toISOString() });
    return clone(review);
  }

  /** Release the provider sandbox after collection while retaining export and operator metadata. */
  async release(sessionId: string): Promise<SessionRecord> {
    const record = await this.load(sessionId);
    if (record.runtime.availability === 'destroyed' || record.state === 'destroyed' || record.state === 'rolled_back') {
      return clone(record);
    }
    if (record.state !== 'collected') {
      throw new SessionError('INVALID_STATE', `the session must be collected before its provider sandbox can be released; current state is ${record.state}`, sessionId);
    }

    const runtime = this.runtimeFor(record);
    const destroyed = await runtime.plane.destroy(record.runId as string);
    const next: SessionRecord = {
      ...this.fromControlRun(record, destroyed, runtime.plane.evidence(destroyed.id)),
      runtime: { ...record.runtime, availability: 'destroyed' },
      updatedAt: this.clock().toISOString()
    };
    await this.save(next);
    this.runtimes.delete(sessionId);
    return clone(next);
  }

  async promote(sessionId: string, reviewedPaths: readonly string[]): Promise<SessionRecord> {
    const record = await this.load(sessionId);
    this.assertPromotionLease(record);
    this.assertSimulatorExport(record);
    if (!record.review) throw new SessionError('INVALID_STATE', 'an existing review is required before promotion', sessionId);
    if (!Array.isArray(reviewedPaths) || reviewedPaths.some((path) => typeof path !== 'string')) {
      throw new SessionError('INVALID_REQUEST', 'reviewedPaths must be an array of paths', sessionId);
    }
    if (!record.baseline || !record.result) {
      throw new SessionError('INVALID_STATE', 'the session has no collected workspace result to promote', sessionId);
    }

    const resultRoot = await this.resultRootFor(record);
    const plan = await createPromotionPlan({
      baseline: record.baseline,
      result: record.result,
      resultRoot,
      hostRoot: record.spec.workspaceRoot
    });
    const paths = [...reviewedPaths];
    if (new Set(paths).size !== paths.length) {
      throw new SessionError('INVALID_REQUEST', 'reviewedPaths must not contain duplicates', sessionId);
    }

    const reviewed: ReviewedPromotionDecision[] = [];
    for (const path of paths) {
      const review = record.review.decisions.find((decision) => decision.path === path);
      if (!review) throw new SessionError('INVALID_STATE', `path ${path} is not present in the persisted review`, sessionId);
      if (review.decision !== 'allow') {
        throw new SessionError('INVALID_STATE', `path ${path} is ${review.decision} and cannot be promoted`, sessionId);
      }
      const planned = plan.decisions.find((decision) => decision.path === path);
      if (!planned || planned.decision !== 'allow' || review.sha256 !== planned.sha256) {
        throw new SessionError('INVALID_STATE', `promotion review does not match the current result SHA-256 for ${path}`, sessionId);
      }
      reviewed.push({ ...review, reviewed: true });
    }

    const stagingRoot = await this.safeStatePath(join(this.stateDir, 'promotions'), record.spec.workspaceRoot, 'promotion staging root');
    const staged = await stagePromotion(plan, { stagingRoot });
    let receipt: PromotionReceipt;
    try {
      receipt = await promotePromotion(staged, reviewed);
    } catch (error) {
      await rollbackPromotion(staged).catch(() => undefined);
      throw new SessionError('INVALID_STATE', error instanceof Error ? error.message : String(error), sessionId, { cause: error });
    }

    const next: SessionRecord = {
      ...record,
      review: {
        ...record.review,
        decisions: record.review.decisions.map((decision) => paths.includes(decision.path) ? { ...decision, reviewed: true } : decision)
      },
      promotion: { status: 'promoted', updatedAt: this.clock().toISOString(), receipt },
      updatedAt: this.clock().toISOString()
    };
    await this.assertPromotionReceiptSafe(next);
    try {
      await this.save(next);
    } catch (error) {
      await rollbackPromotion(receipt).catch(() => undefined);
      throw error;
    }
    return clone(next);
  }

  async revoke(sessionId: string): Promise<SessionRecord> {
    const record = await this.load(sessionId);
    const runtime = this.runtimeFor(record);
    const revoked = runtime.plane.revoke(record.runId as string);
    const next = this.fromControlRun(record, revoked, runtime.plane.evidence(revoked.id));
    await this.save(next);
    return clone(next);
  }

  async rollback(sessionId: string): Promise<SessionRecord> {
    const record = await this.load(sessionId);
    if (record.state === 'rolled_back') return clone(record);
    let next = record;
    if (record.promotion?.status === 'promoted') {
      await this.assertPromotionReceiptSafe(record);
      await rollbackPromotion(record.promotion.receipt);
      next = {
        ...record,
        promotion: { ...record.promotion, status: 'rolled_back', updatedAt: this.clock().toISOString() },
        updatedAt: this.clock().toISOString()
      };
      await this.save(next);
    }

    let runtime: RuntimeContext;
    try {
      runtime = this.runtimeFor(next);
    } catch (error) {
      if (next.state === 'destroyed' && next.runtime.availability === 'destroyed') {
        const rolledBack: SessionRecord = {
          ...next,
          state: 'rolled_back',
          runtime: { ...next.runtime, availability: 'destroyed' },
          updatedAt: this.clock().toISOString()
        };
        await this.save(rolledBack);
        this.runtimes.delete(sessionId);
        return clone(rolledBack);
      }
      if (record.promotion?.status === 'promoted') {
        throw new SessionRecoveryError(record.id, 'host files were restored from the persisted promotion receipt, but the original provider sandbox cannot be controlled after restart; inspection remains available');
      }
      throw error;
    }
    const rolledBack = await runtime.plane.rollback(next.runId as string);
    next = this.fromControlRun(next, rolledBack, runtime.plane.evidence(rolledBack.id));
    const destroyed: SessionRecord = {
      ...next,
      state: 'rolled_back',
      runtime: { ...next.runtime, availability: 'destroyed' },
      updatedAt: this.clock().toISOString()
    };
    await this.save(destroyed);
    this.runtimes.delete(sessionId);
    return clone(destroyed);
  }

  private async exportResult(provider: SandboxProvider, handle: SandboxHandle, sessionId: string): Promise<string | undefined> {
    const exporter = (provider as ExportingSandboxProvider).exportWorkspace;
    if (!exporter) return undefined;
    const resultRoot = await this.safeStatePath(this.resultPath(sessionId), undefined, 'result root');
    await exporter.call(provider, handle, resultRoot);
    return await canonicalExistingDirectory(resultRoot, 'result root');
  }

  private runtimeFor(record: SessionRecord): RuntimeContext {
    if (!record.runId || !record.handle) {
      throw new SessionRecoveryError(record.id, 'the session has no recoverable sandbox handle');
    }
    const runtime = this.runtimes.get(record.id);
    if (!runtime) {
      throw new SessionRecoveryError(record.id, 'the original provider context is unavailable; persisted sessions support inspection after restart, but sandbox control is in-process only');
    }
    return runtime;
  }

  private leaseRequest(request: SessionLeaseRequest | undefined): LeaseRequest {
    return {
      operations: request?.operations ?? DEFAULT_OPERATIONS,
      allowedDomains: request?.allowedDomains ?? [],
      expiresAt: request?.expiresAt ?? new Date(this.clock().getTime() + 60 * 60 * 1000).toISOString()
    };
  }

  private withCommandRunner(provider: SandboxProvider): SandboxProvider {
    if (!this.commandRunner) return provider;
    const commandRunner = this.commandRunner;
    const wrapped: ExportingSandboxProvider = {
      createRun: (spec) => provider.createRun(spec),
      uploadWorkspace: (handle, source) => provider.uploadWorkspace(handle, source),
      execute: async function* (handle: SandboxHandle, command: string, args: readonly string[]) {
        const events = commandRunner(provider, handle, command, args);
        for await (const event of events) yield event;
      },
      collectWorkspace: (handle) => provider.collectWorkspace(handle),
      destroy: (handle) => provider.destroy(handle)
    };
    const exporter = (provider as ExportingSandboxProvider).exportWorkspace;
    if (exporter) {
      const exportWorkspace = exporter;
      return {
        ...wrapped,
        exportWorkspace: (handle: SandboxHandle, destination: string) => exportWorkspace.call(provider, handle, destination)
      } as SandboxProvider;
    }
    return wrapped;
  }

  private fromControlRun(record: SessionRecord, run: ControlRun, evidence: readonly RuntimeEvent[]): SessionRecord {
    return {
      ...record,
      runId: run.id,
      state: run.state,
      handle: { ...run.handle },
      ...(run.lease ? { lease: copyLease(run.lease) } : {}),
      evidence: evidence.map((event) => ({ ...event, payload: { ...event.payload } })),
      runtime: { provider: run.handle.provider, sandboxId: run.handle.id, availability: 'in-process-only' },
      updatedAt: this.clock().toISOString()
    };
  }

  private async save(record: SessionRecord): Promise<void> {
    assertPersistable(record);
    await this.assertStateDirOutsideWorkspace(record.spec.workspaceRoot);
    const path = await this.safeStatePath(this.filePath(record.id), record.spec.workspaceRoot, 'session state path');
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${this.idFactory()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      throw new SessionError('STATE_IO', `could not persist session ${record.id}`, record.id, { cause: error });
    }
  }

  private filePath(sessionId: string): string {
    if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId)) throw new SessionError('INVALID_REQUEST', 'session id is invalid', sessionId);
    return join(this.stateDir, 'sessions', `${sessionId}.json`);
  }

  private resultPath(sessionId: string): string {
    return join(this.stateDir, 'results', sessionId);
  }

  private async resultRootFor(record: SessionRecord): Promise<string> {
    const expected = await this.safeStatePath(this.resultPath(record.id), record.spec.workspaceRoot, 'result root');
    if (!record.resultRoot || (await canonicalPath(record.resultRoot)) !== (await canonicalPath(expected))) {
      throw new SessionError('INVALID_STATE', 'the provider did not export a safe external result workspace; promotion is unavailable', record.id);
    }
    try {
      return await canonicalExistingDirectory(record.resultRoot, 'result root');
    } catch (error) {
      throw new SessionError('INVALID_STATE', 'the provider did not export a safe external result workspace; promotion is unavailable', record.id, { cause: error });
    }
  }

  private async assertPromotionReceiptSafe(record: SessionRecord): Promise<void> {
    const receipt = record.promotion?.receipt;
    if (!receipt) throw new SessionError('INVALID_RECORD', 'promotion receipt is missing', record.id);
    const plan = receipt.staged.plan;
    const workspaceRoot = await canonicalExistingDirectory(record.spec.workspaceRoot, 'workspaceRoot');
    const hostRoot = await canonicalExistingDirectory(plan.hostRoot, 'promotion host root');
    const expectedResultRoot = await this.safeStatePath(this.resultPath(record.id), record.spec.workspaceRoot, 'result root');
    const resultRoot = await canonicalExistingDirectory(plan.resultRoot, 'promotion result root');
    const stateRoot = await canonicalPath(this.stateDir);
    const stageRoot = await canonicalExistingDirectory(receipt.staged.stageRoot, 'promotion staging root');
    if (hostRoot !== workspaceRoot) {
      throw new SessionError('INVALID_RECORD', 'promotion receipt host root does not match the selected workspace', record.id);
    }
    if (resultRoot !== await canonicalPath(expectedResultRoot)) {
      throw new SessionError('INVALID_RECORD', 'promotion receipt result root is not safe', record.id);
    }
    if (!isWithinPath(stateRoot, stageRoot) || isWithinPath(workspaceRoot, stageRoot)) {
      throw new SessionError('INVALID_RECORD', 'promotion receipt staging root is not safe', record.id);
    }
    for (const entry of receipt.staged.entries) {
      if (!isSafeRelativePath(entry.path)) throw new SessionError('INVALID_RECORD', `promotion receipt contains an unsafe path: ${entry.path}`, record.id);
      for (const path of [entry.resultPath, entry.backupPath]) {
        if (path) {
          const canonicalEntryPath = await canonicalPath(path);
          if (!isWithinPath(stageRoot, canonicalEntryPath) || isWithinPath(workspaceRoot, canonicalEntryPath)) {
            throw new SessionError('INVALID_RECORD', 'promotion receipt contains an unsafe staging path', record.id);
          }
        }
        if (path && isWithinPath(workspaceRoot, path)) {
          throw new SessionError('INVALID_RECORD', 'promotion receipt contains an unsafe staging path', record.id);
        }
      }
    }
  }

  private async assertStateDirOutsideWorkspace(workspaceRoot: string): Promise<void> {
    const workspace = await canonicalPath(workspaceRoot);
    await this.canonicalizeStateDir();
    if (isWithinPath(workspace, this.stateDir)) {
      throw new SessionError('STATE_DIRECTORY_UNSAFE', 'stateDir must be outside the selected workspace');
    }
  }

  private async canonicalizeStateDir(): Promise<void> {
    this.stateDir = await canonicalPath(this.stateDir);
  }

  private async safeStatePath(path: string, workspaceRoot: string | undefined, label: string): Promise<string> {
    await this.canonicalizeStateDir();
    const canonical = await canonicalPath(path);
    if (!isWithinPath(this.stateDir, canonical) || (workspaceRoot && isWithinPath(await canonicalPath(workspaceRoot), canonical))) {
      throw new SessionError('STATE_DIRECTORY_UNSAFE', `${label} is outside the safe state directory`, undefined);
    }
    return canonical;
  }

  private assertPromotionLease(record: SessionRecord): void {
    if (!record.lease || !record.runId) {
      throw new SessionError('INVALID_STATE', 'the session has no valid lease for promotion', record.id);
    }
    if (record.lease.runId !== record.runId || record.lease.workspaceRoot !== record.spec.workspaceRoot || (record.handle && record.lease.sandboxId !== record.handle.id)) {
      throw new SessionError('INVALID_STATE', 'lease is not scoped to the persisted session', record.id);
    }
    if (record.state === 'revoked') {
      throw new SessionError('INVALID_STATE', 'lease_revoked: lease has been revoked', record.id);
    }
    if (!['collected', 'destroyed'].includes(record.state)) {
      throw new SessionError('INVALID_STATE', `session state ${record.state} is not eligible for promotion`, record.id);
    }
    if (!record.lease.operations.includes('promotion.submit')) {
      throw new SessionError('INVALID_STATE', 'the session lease does not allow promotion.submit', record.id);
    }
    const invalidOperation = record.lease.operations.find((operation) => !DEFAULT_OPERATIONS.includes(operation));
    if (invalidOperation !== undefined) {
      throw new SessionError('INVALID_STATE', `lease contains unknown operation ${String(invalidOperation)}`, record.id);
    }
    const expiresAt = Date.parse(record.lease.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock().getTime()) {
      throw new SessionError('INVALID_STATE', 'lease_expired: lease has expired', record.id);
    }
    const expectedPolicyHash = policyHash({
      runId: record.lease.runId,
      sandboxId: record.lease.sandboxId,
      workspaceRoot: record.lease.workspaceRoot,
      operations: normalizeLeaseOperations(record.lease.operations),
      allowedDomains: normalizeLeaseStrings(record.lease.allowedDomains),
      expiresAt: new Date(expiresAt).toISOString()
    });
    if (record.lease.policyHash !== expectedPolicyHash) {
      throw new SessionError('INVALID_STATE', 'lease policy hash does not match its policy', record.id);
    }
  }

  private assertSimulatorExport(record: SessionRecord): void {
    if (record.spec.provider !== 'simulator' || record.runtime.provider !== 'simulator') {
      throw new SessionError('INVALID_STATE', 'Daytona sessions cannot be promoted by the local operator; promotion requires a simulator-exported result', record.id);
    }
    if (!record.resultRoot) {
      throw new SessionError('INVALID_STATE', 'the session has no exported result root; promotion is unavailable', record.id);
    }
  }
}

export class PersistentSessionRuntime extends SessionRuntime {}

function validateStartRequest(request: SessionStartRequest): void {
  if (!request || typeof request !== 'object') throw new SessionError('INVALID_REQUEST', 'start request is required');
  if (!request.workspaceRoot?.trim()) throw new SessionError('INVALID_REQUEST', 'workspaceRoot is required');
  if (request.provider !== 'simulator' && request.provider !== 'daytona') throw new SessionError('INVALID_REQUEST', 'provider must be simulator or daytona');
  if (!request.command?.trim()) throw new SessionError('INVALID_REQUEST', 'command is required');
  if (!Array.isArray(request.commandArgs) || request.commandArgs.some((argument) => typeof argument !== 'string')) throw new SessionError('INVALID_REQUEST', 'commandArgs must be an array of strings');
}

function persistedSpec(request: SessionStartRequest): PersistedSessionSpec {
  return { workspaceRoot: request.workspaceRoot, provider: request.provider, command: request.command, commandArgs: redactArguments(request.commandArgs) };
}

function redactArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  let redactNext = false;
  for (const argument of args) {
    if (redactNext) {
      result.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const equals = argument.indexOf('=');
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    const attachedHeader = /^-H\S/i.test(argument);
    if (HEADER_ARGUMENT.test(flag) || attachedHeader || SENSITIVE_ARGUMENT.test(flag)) {
      if (equals >= 0) {
        result.push(`${flag}=[REDACTED]`);
      } else if (attachedHeader) {
        result.push('-H[REDACTED]');
      } else if (argument.startsWith('-')) {
        result.push(argument);
        redactNext = true;
      } else {
        result.push('[REDACTED]');
      }
      continue;
    }
    if (CREDENTIAL_VALUE.test(argument)) {
      const header = argument.match(/^(\s*(?:authorization|cookie)\s*):/i);
      result.push(header ? `${header[1]}: [REDACTED]` : '[REDACTED]');
      continue;
    }
    result.push(argument);
  }
  return result;
}

async function captureBaseline(lease: CapabilityLease, clock: () => Date): Promise<WorkspaceManifest> {
  const bridge = await CageBridge.open(lease, { clock });
  const entries: FileManifestEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await bridge.list(path)) {
      entries.push({ ...entry });
      if (entry.kind === 'directory') await visit(entry.path);
    }
  };
  await visit('.');
  const sorted = entries.sort((left, right) => left.path.localeCompare(right.path));
  return { root: lease.workspaceRoot, createdAt: clock().toISOString(), entries: sorted, hash: manifestHash(sorted) };
}

function manifestDiff(baseline: WorkspaceManifest | undefined, result: WorkspaceManifest | undefined): PromotionChange[] {
  if (!result) return [];
  const before = new Map((baseline?.entries ?? []).map((entry) => [entry.path, entry]));
  const after = new Map(result.entries.map((entry) => [entry.path, entry]));
  const changes: PromotionChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(path);
    const right = after.get(path);
    if (left && right && sameManifestEntry(left, right)) continue;
    changes.push({ path, kind: left ? (right ? 'modified' : 'deleted') : 'added', ...(left ? { baseline: left } : {}), ...(right ? { result: right } : {}) });
  }
  return changes;
}

function reviewChange(change: PromotionChange): PromotionDecision {
  if (!isSafeRelativePath(change.path)) return { path: change.path, decision: 'deny', reasons: ['path traversal or absolute path is not allowed'] };
  if (change.result?.kind === 'symlink' || change.baseline?.kind === 'symlink') return { path: change.path, decision: 'deny', reasons: ['symlink promotion is not allowed'] };
  const protectedReasons = classifyPromotionPath(change.path);
  return {
    path: change.path,
    decision: protectedReasons.length > 0 ? 'quarantine' : 'allow',
    reasons: protectedReasons.length > 0 ? protectedReasons : ['change is outside protected execution surfaces'],
    ...(change.result?.sha256 ? { sha256: change.result.sha256 } : {})
  };
}

function sameManifestEntry(left: FileManifestEntry, right: FileManifestEntry): boolean {
  return left.kind === right.kind && left.size === right.size && left.sha256 === right.sha256;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function manifestHash(entries: readonly FileManifestEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function copyLease(lease: CapabilityLease): CapabilityLease {
  return { ...lease, operations: [...lease.operations], allowedDomains: [...lease.allowedDomains] };
}

function normalizeLeaseOperations(operations: readonly LeaseOperation[]): LeaseOperation[] {
  return [...new Set(operations)].sort();
}

function normalizeLeaseStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function errorInfo(error: unknown): SessionErrorInfo {
  const name = error instanceof Error ? error.name : 'Error';
  const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return { name, message, ...(code ? { code } : {}) };
}

function sanitizeMessage(value: string): string {
  return value
    .replaceAll(/((?:authorization|cookie)\s*:)[ \t]*(?!\[REDACTED\])[^\r\n,]+/gi, '$1 [REDACTED]')
    .replaceAll(/((?:--header|-H|--auth)(?:=|\s+))(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replaceAll(/\b(basic|bearer)\s+(?!\[REDACTED\])[^\s,;]+/gi, '$1 [REDACTED]')
    .replaceAll(/(?:api[-_ ]?key|access[-_ ]?token|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replaceAll(/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9._-]+\b/gi, '[REDACTED]');
}

function parseSessionRecord(value: unknown, sessionId: string): SessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionError('INVALID_RECORD', `session ${sessionId} is not an object`, sessionId);
  const record = value as Partial<SessionRecord>;
  if (record.version !== CURRENT_VERSION || record.id !== sessionId || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' || typeof record.state !== 'string' || !record.spec || !record.runtime || !Array.isArray(record.evidence)) throw new SessionError('INVALID_RECORD', `session ${sessionId} is missing required fields`, sessionId);
  try {
    assertNoPersistedSecrets(record);
  } catch (error) {
    throw new SessionError('INVALID_RECORD', `session ${sessionId} contains unsafe persisted data`, sessionId, { cause: error });
  }
  return clone(record as SessionRecord);
}

function assertPersistable(record: SessionRecord): void {
  assertNoPersistedSecrets(record);
}

function assertNoPersistedSecrets(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    if (sanitizeMessage(value) !== value) throw new Error(`credential-like value found in ${key || 'record'}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoPersistedSecrets(item, key);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(childKey) && typeof childValue === 'string' && childValue !== '[REDACTED]') throw new Error(`sensitive field found in ${childKey}`);
    assertNoPersistedSecrets(childValue, childKey);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isWithinPath(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate));
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(fromParent));
}

async function canonicalPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const root = await realpath(candidate);
      return suffix.reverse().reduce((current, part) => join(current, part), root);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function canonicalExistingDirectory(path: string, name: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const info = await lstat(canonical);
  if (!info.isDirectory()) throw new Error(`${name} must be an existing directory`);
  return canonical;
}
