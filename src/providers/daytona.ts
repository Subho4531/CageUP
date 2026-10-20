import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type {
  FileManifestEntry,
  RuntimeEvent,
  RunSpec,
  SandboxHandle,
  SandboxProvider,
  WorkspaceManifest
} from '../core/contracts.js';

/**
 * Daytona's API surface is kept behind this small path map on purpose. The
 * provider contract is stable, while the endpoint paths can be adjusted when
 * a deployed Daytona API version is selected.
 */
export interface DaytonaEndpointPaths {
  readonly createSandbox: string;
  readonly uploadWorkspace: (sandboxId: string) => string;
  readonly execute: (sandboxId: string) => string;
  readonly collectWorkspace: (sandboxId: string) => string;
  readonly destroySandbox: (sandboxId: string) => string;
}

const sandboxPath = (sandboxId: string, suffix = '') => `/sandboxes/${encodeURIComponent(sandboxId)}${suffix}`;

/** Protocol defaults used by the offline adapter tests; they are not a claim about every Daytona deployment. */
export const DEFAULT_DAYTONA_ENDPOINTS: DaytonaEndpointPaths = {
  createSandbox: '/sandboxes',
  uploadWorkspace: (sandboxId) => sandboxPath(sandboxId, '/workspace'),
  execute: (sandboxId) => sandboxPath(sandboxId, '/execute'),
  collectWorkspace: (sandboxId) => sandboxPath(sandboxId, '/workspace/manifest'),
  destroySandbox: (sandboxId) => sandboxPath(sandboxId)
};

export type DaytonaErrorCode = 'CONFIGURATION' | 'HTTP' | 'NETWORK' | 'PROTOCOL' | 'STATE';

export class DaytonaError extends Error {
  readonly code: DaytonaErrorCode;

  constructor(code: DaytonaErrorCode, message: string) {
    super(`Daytona ${code.toLowerCase()}: ${message}`);
    this.name = 'DaytonaError';
    this.code = code;
  }
}

export interface DaytonaClientOptions {
  readonly apiUrl?: string;
  readonly apiToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpoints?: DaytonaEndpointPaths;
}

export interface DaytonaCreateResponse {
  readonly id: string;
  readonly createdAt?: string;
}

export interface DaytonaUploadEntry {
  readonly path: string;
  readonly kind: FileManifestEntry['kind'];
  readonly size: number;
  readonly sha256?: string;
  readonly contentBase64?: string;
}

export interface DaytonaUploadRequest {
  readonly root: string;
  readonly entries: readonly DaytonaUploadEntry[];
}

export interface DaytonaExecuteRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface DaytonaClientAdapter {
  createSandbox(spec: RunSpec): Promise<DaytonaCreateResponse>;
  uploadWorkspace(sandboxId: string, request: DaytonaUploadRequest): Promise<void>;
  execute(sandboxId: string, request: DaytonaExecuteRequest): Promise<readonly DaytonaRuntimeEvent[]>;
  collectWorkspace(sandboxId: string): Promise<WorkspaceManifest>;
  destroySandbox(sandboxId: string): Promise<void>;
}

export interface DaytonaRuntimeEvent {
  readonly id?: string;
  readonly type: RuntimeEvent['type'];
  readonly runId?: string;
  readonly occurredAt?: string;
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
  readonly previousHash?: string | null;
  readonly hash?: string;
}

const REMOTE_WORKSPACE_ROOT = '/workspace/project';
const SENSITIVE_BASENAME = /^\.env(?:\.|$)/i;
const RUNTIME_EVENT_TYPES = new Set<RuntimeEvent['type']>([
  'RUN_CREATED',
  'SANDBOX_CREATED',
  'COMMAND_STARTED',
  'COMMAND_EXITED',
  'COMMAND_FAILED',
  'LEASE_GRANTED',
  'ZK_ROUTE_ASSIGNED',
  'EGRESS_ALLOWED',
  'EGRESS_BLOCKED',
  'FILE_CHANGED',
  'FILE_QUARANTINED',
  'PROMOTION_BLOCKED',
  'LEASE_REVOKED',
  'ROLLBACK_COMPLETED',
  'SANDBOX_DESTROYED'
]);

export class DaytonaClient implements DaytonaClientAdapter {
  private readonly apiUrl: URL;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: DaytonaEndpointPaths;

  constructor(options: DaytonaClientOptions = {}) {
    if (!options.apiUrl?.trim()) {
      throw new DaytonaError('CONFIGURATION', 'DAYTONA_API_URL is required');
    }
    if (!options.apiToken?.trim()) {
      throw new DaytonaError('CONFIGURATION', 'DAYTONA_API_TOKEN is required');
    }

    let apiUrl: URL;
    try {
      apiUrl = new URL(options.apiUrl.trim());
    } catch {
      throw new DaytonaError('CONFIGURATION', 'DAYTONA_API_URL must be a valid HTTP or HTTPS URL');
    }
    if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
      throw new DaytonaError('CONFIGURATION', 'DAYTONA_API_URL must use HTTP or HTTPS');
    }

    this.apiUrl = apiUrl;
    this.apiToken = options.apiToken.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoints = options.endpoints ?? DEFAULT_DAYTONA_ENDPOINTS;
  }

  async createSandbox(spec: RunSpec): Promise<DaytonaCreateResponse> {
    const response = await this.requestJson<unknown>('POST', this.endpoints.createSandbox, {
      workspaceRoot: REMOTE_WORKSPACE_ROOT,
      command: spec.command,
      args: [...spec.commandArgs]
    });
    const body = asRecord(response, 'create response');
    const id = stringValue(body.id) ?? stringValue(body.sandboxId);
    if (!id) throw new DaytonaError('PROTOCOL', 'create response did not include a sandbox id');
    const createdAt = stringValue(body.createdAt);
    return createdAt ? { id, createdAt } : { id };
  }

  async uploadWorkspace(sandboxId: string, request: DaytonaUploadRequest): Promise<void> {
    await this.requestJson('POST', this.endpoints.uploadWorkspace(sandboxId), request);
  }

  async execute(sandboxId: string, request: DaytonaExecuteRequest): Promise<readonly DaytonaRuntimeEvent[]> {
    const response = await this.requestJson<unknown>('POST', this.endpoints.execute(sandboxId), {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd
    });
    return parseRuntimeEvents(response);
  }

  async collectWorkspace(sandboxId: string): Promise<WorkspaceManifest> {
    const response = await this.requestJson<unknown>('GET', this.endpoints.collectWorkspace(sandboxId));
    const body = asRecord(response, 'collect response');
    const manifest = 'manifest' in body ? body.manifest : body;
    return parseWorkspaceManifest(manifest);
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await this.requestJson('DELETE', this.endpoints.destroySandbox(sandboxId));
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.urlFor(path);
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.apiToken}`
    });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      throw new DaytonaError('NETWORK', `request failed for ${method} ${path}`);
    }

    if (!response.ok) {
      throw new DaytonaError('HTTP', `request failed for ${method} ${path}: HTTP ${response.status}`);
    }
    if (method === 'DELETE' || response.status === 204) return undefined as T;

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new DaytonaError('PROTOCOL', `response body could not be read for ${method} ${path}`);
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DaytonaError('PROTOCOL', `response was not valid JSON for ${method} ${path}`);
    }
  }

  private urlFor(path: string): URL {
    try {
      return new URL(path.replace(/^\/+/, ''), this.apiUrl.href.endsWith('/') ? this.apiUrl.href : `${this.apiUrl.href}/`);
    } catch {
      throw new DaytonaError('CONFIGURATION', 'Daytona endpoint path is invalid');
    }
  }
}

export class FetchDaytonaClient extends DaytonaClient {}

export interface DaytonaProviderOptions extends DaytonaClientOptions {
  readonly client?: DaytonaClientAdapter;
  readonly clock?: () => Date;
}

interface DaytonaState {
  readonly handle: SandboxHandle;
  readonly spec: RunSpec;
  uploaded: boolean;
  destroyed: boolean;
}

export class DaytonaProvider implements SandboxProvider {
  private readonly states = new Map<string, DaytonaState>();
  private readonly client: DaytonaClientAdapter;
  private readonly clock: () => Date;

  constructor(options: DaytonaProviderOptions = {}) {
    this.client = options.client ?? new FetchDaytonaClient(options);
    this.clock = options.clock ?? (() => new Date());
  }

  async createRun(spec: RunSpec): Promise<SandboxHandle> {
    if (spec.provider !== 'daytona') throw new DaytonaError('STATE', 'DaytonaProvider requires provider=daytona');
    if (!spec.workspaceRoot.trim()) throw new DaytonaError('STATE', 'workspaceRoot is required');
    if (!spec.command.trim()) throw new DaytonaError('STATE', 'command is required');
    if (!Array.isArray(spec.commandArgs) || spec.commandArgs.some((argument) => typeof argument !== 'string')) {
      throw new DaytonaError('STATE', 'commandArgs must be an array of strings');
    }

    const created = await this.client.createSandbox(spec);
    const handle: SandboxHandle = {
      provider: 'daytona',
      id: created.id,
      createdAt: created.createdAt ?? this.clock().toISOString()
    };
    this.states.set(handle.id, { handle, spec, uploaded: false, destroyed: false });
    return handle;
  }

  async uploadWorkspace(handle: SandboxHandle, source: string): Promise<void> {
    const state = this.state(handle);
    if (state.uploaded) throw new DaytonaError('STATE', 'workspace has already been uploaded');
    const sourcePath = resolve(source);
    const sourceInfo = await stat(sourcePath).catch(() => undefined);
    if (!sourceInfo?.isDirectory()) throw new DaytonaError('STATE', 'workspace source must be an existing directory');
    const entries = await uploadEntries(sourcePath);
    await this.client.uploadWorkspace(handle.id, { root: REMOTE_WORKSPACE_ROOT, entries });
    state.uploaded = true;
  }

  async *execute(handle: SandboxHandle, command: string, args: readonly string[]): AsyncIterable<RuntimeEvent> {
    const state = this.state(handle);
    if (!state.uploaded) throw new DaytonaError('STATE', 'workspace must be uploaded before execution');
    if (!command.trim()) throw new DaytonaError('STATE', 'command is required');
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      throw new DaytonaError('STATE', 'command args must be an array of strings');
    }

    const wireEvents = await this.client.execute(handle.id, { command, args: [...args], cwd: REMOTE_WORKSPACE_ROOT });
    for (const wireEvent of wireEvents) {
      const event = normalizeRuntimeEvent(handle.id, wireEvent, this.clock);
      yield event;
      if (event.type === 'COMMAND_FAILED') {
        const exitCode = typeof event.payload.exitCode === 'number' ? ` with exit code ${event.payload.exitCode}` : '';
        throw new DaytonaError('STATE', `Daytona command failed${exitCode}`);
      }
    }
  }

  async collectWorkspace(handle: SandboxHandle): Promise<WorkspaceManifest> {
    const state = this.state(handle);
    if (!state.uploaded) throw new DaytonaError('STATE', 'workspace must be uploaded before collection');
    return this.client.collectWorkspace(handle.id);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const state = this.states.get(handle.id);
    if (!state || state.destroyed) return;
    await this.client.destroySandbox(handle.id);
    state.destroyed = true;
  }

  private state(handle: SandboxHandle): DaytonaState {
    const state = this.states.get(handle.id);
    if (!state || state.destroyed) throw new DaytonaError('STATE', `sandbox ${handle.id} is not available`);
    return state;
  }
}

async function uploadEntries(root: string): Promise<DaytonaUploadEntry[]> {
  const entries: DaytonaUploadEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (SENSITIVE_BASENAME.test(child.name)) continue;
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        entries.push({ path, kind: 'directory', size: 0 });
        await visit(absolute);
      } else if (info.isSymbolicLink()) {
        throw new DaytonaError('STATE', `workspace upload does not support symlinks: ${path}`);
      } else if (info.isFile()) {
        const content = await readFile(absolute);
        entries.push({
          path,
          kind: 'file',
          size: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
          contentBase64: content.toString('base64')
        });
      }
    }
  };
  await visit(root);
  return entries;
}

function parseRuntimeEvents(value: unknown): readonly DaytonaRuntimeEvent[] {
  const container = Array.isArray(value) ? value : asRecord(value, 'execute response').events;
  if (!Array.isArray(container)) throw new DaytonaError('PROTOCOL', 'execute response did not include an events array');
  return container.map((event, index) => {
    const body = asRecord(event, `execute event ${index}`);
    const type = stringValue(body.type);
    if (!type || !RUNTIME_EVENT_TYPES.has(type as RuntimeEvent['type'])) {
      throw new DaytonaError('PROTOCOL', `execute event ${index} has an invalid type`);
    }
    const payload = body.payload;
    if (payload !== undefined && !isRuntimePayload(payload)) {
      throw new DaytonaError('PROTOCOL', `execute event ${index} has an invalid payload`);
    }
    const id = stringValue(body.id);
    const runId = stringValue(body.runId);
    const occurredAt = stringValue(body.occurredAt);
    const hash = stringValue(body.hash);
    return {
      type: type as RuntimeEvent['type'],
      ...(id ? { id } : {}),
      ...(runId ? { runId } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(payload ? { payload } : {}),
      ...(body.previousHash === null || typeof body.previousHash === 'string' ? { previousHash: body.previousHash } : {}),
      ...(hash ? { hash } : {})
    };
  });
}

function normalizeRuntimeEvent(runId: string, wire: DaytonaRuntimeEvent, clock: () => Date): RuntimeEvent {
  const payload = wire.payload ?? {};
  const body = JSON.stringify({ type: wire.type, runId, payload });
  return {
    id: wire.id ?? randomUUID(),
    type: wire.type,
    runId,
    occurredAt: wire.occurredAt ?? clock().toISOString(),
    payload,
    previousHash: wire.previousHash ?? null,
    hash: wire.hash ?? createHash('sha256').update(body).digest('hex')
  };
}

function parseWorkspaceManifest(value: unknown): WorkspaceManifest {
  const body = asRecord(value, 'workspace manifest');
  const root = stringValue(body.root);
  const createdAt = stringValue(body.createdAt);
  if (!root || !createdAt || !Array.isArray(body.entries) || !stringValue(body.hash)) {
    throw new DaytonaError('PROTOCOL', 'workspace manifest is missing required fields');
  }
  const entries = body.entries.map((entry, index) => {
    const item = asRecord(entry, `workspace manifest entry ${index}`);
    const path = stringValue(item.path);
    const kind = stringValue(item.kind);
    const size = item.size;
    if (!path || (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') || typeof size !== 'number') {
      throw new DaytonaError('PROTOCOL', `workspace manifest entry ${index} is invalid`);
    }
    const sha256 = stringValue(item.sha256);
    return {
      path,
      kind,
      size,
      ...(sha256 ? { sha256 } : {})
    } as FileManifestEntry;
  });
  return { root, createdAt, entries, hash: stringValue(body.hash) as string };
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DaytonaError('PROTOCOL', `${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRuntimePayload(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => ['string', 'number', 'boolean'].includes(typeof entry));
}
