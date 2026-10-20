import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, win32 } from 'node:path';
import type { CapabilityLease, FileManifestEntry, LeaseOperation } from './core/contracts.js';

const leaseOperations: readonly LeaseOperation[] = [
  'workspace.list',
  'workspace.read',
  'workspace.write',
  'workspace.stat',
  'workspace.diff',
  'promotion.submit',
  'run.status'
];

const knownLeaseOperations = new Set<LeaseOperation>(leaseOperations);

export type CageBridgeLease = Pick<CapabilityLease, 'workspaceRoot' | 'operations' | 'expiresAt'>;
export type WorkspaceEntry = FileManifestEntry;
export type WorkspaceDiffStatus = 'added' | 'modified' | 'deleted';

export interface WorkspaceDiff {
  readonly path: string;
  readonly status: WorkspaceDiffStatus;
  readonly before?: WorkspaceEntry;
  readonly after?: WorkspaceEntry;
}

export interface CageBridgeOptions {
  readonly clock?: () => Date;
  readonly baseline?: readonly WorkspaceEntry[];
}

export type CageBridgeErrorCode =
  | 'INVALID_LEASE'
  | 'LEASE_EXPIRED'
  | 'OPERATION_DENIED'
  | 'INVALID_PATH'
  | 'PATH_NOT_FOUND'
  | 'PATH_ESCAPE'
  | 'UNSUPPORTED_ENTRY';

export class CageBridgeError extends Error {
  constructor(message: string, readonly code: CageBridgeErrorCode) {
    super(message);
    this.name = 'CageBridgeError';
  }
}

/** A lease-scoped filesystem capability gateway without process or shell APIs. */
export class CageBridge {
  private readonly workspaceRoot: string;
  private readonly allowedOperations: ReadonlySet<LeaseOperation>;
  private readonly expiresAt: number;
  private readonly clock: () => Date;
  private readonly rootRealPathPromise: Promise<string>;
  private baseline: readonly WorkspaceEntry[] | undefined;

  constructor(lease: CageBridgeLease, options: CageBridgeOptions = {}) {
    if (!lease.workspaceRoot.trim()) {
      throw new CageBridgeError('lease workspaceRoot is required', 'INVALID_LEASE');
    }

    const invalidOperation = lease.operations.find((operation) => !knownLeaseOperations.has(operation));
    if (invalidOperation !== undefined) {
      throw new CageBridgeError(`unknown lease operation: ${String(invalidOperation)}`, 'INVALID_LEASE');
    }

    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new CageBridgeError('lease expiresAt must be a valid timestamp', 'INVALID_LEASE');
    }

    this.workspaceRoot = resolve(lease.workspaceRoot);
    this.allowedOperations = new Set(lease.operations);
    this.expiresAt = expiresAt;
    this.clock = options.clock ?? (() => new Date());
    this.baseline = options.baseline === undefined ? undefined : [...options.baseline];
    this.rootRealPathPromise = this.loadRootRealPath();
  }

  /** Capture the selected workspace as the baseline used by diff(). */
  static async open(lease: CageBridgeLease, options: CageBridgeOptions = {}): Promise<CageBridge> {
    const bridge = new CageBridge(lease, options);
    bridge.ensureLeaseActive();
    if (options.baseline === undefined) bridge.baseline = await bridge.snapshot();
    return bridge;
  }

  async list(path = '.'): Promise<readonly WorkspaceEntry[]> {
    this.authorize('workspace.list');
    const directory = await this.secureExistingPath(path);
    const info = await lstat(directory);
    if (!info.isDirectory()) {
      throw new CageBridgeError(`not a directory: ${path}`, 'UNSUPPORTED_ENTRY');
    }

    const normalizedDirectory = this.normalizeRelativePath(path);
    const entries = await readdir(directory, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = normalizedDirectory === '.' ? entry.name : `${normalizedDirectory}/${entry.name}`;
        return this.describePath(join(directory, entry.name), entryPath);
      })
    );
    return listed.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<string> {
    this.authorize('workspace.read');
    const filePath = await this.secureExistingPath(path);
    const targetPath = await realpath(filePath);
    const info = await lstat(targetPath);
    if (!info.isFile()) {
      throw new CageBridgeError(`not a regular file: ${path}`, 'UNSUPPORTED_ENTRY');
    }
    return readFile(targetPath, 'utf8');
  }

  async write(path: string, content: string | Uint8Array): Promise<WorkspaceEntry> {
    this.authorize('workspace.write');
    const normalizedPath = this.normalizeRelativePath(path);
    if (normalizedPath === '.') {
      throw new CageBridgeError('cannot write the workspace root', 'INVALID_PATH');
    }
    const filePath = await this.secureWritePath(path);
    await writeFile(filePath, content);
    return this.describePath(filePath, normalizedPath);
  }

  async stat(path: string): Promise<WorkspaceEntry> {
    this.authorize('workspace.stat');
    const filePath = await this.secureExistingPath(path);
    return this.describePath(filePath, this.normalizeRelativePath(path));
  }

  /** Compare the current workspace with the captured or supplied baseline. */
  async diff(baseline: readonly WorkspaceEntry[] = this.baseline ?? []): Promise<readonly WorkspaceDiff[]> {
    this.authorize('workspace.diff');
    const currentEntries = await this.snapshot();
    const before = this.entryMap(baseline);
    const after = this.entryMap(currentEntries);
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
    const changes: WorkspaceDiff[] = [];

    for (const path of paths) {
      const previous = before.get(path);
      const current = after.get(path);
      if (previous === undefined && current !== undefined) {
        changes.push({ path, status: 'added', after: current });
      } else if (previous !== undefined && current === undefined) {
        changes.push({ path, status: 'deleted', before: previous });
      } else if (previous !== undefined && current !== undefined && !this.sameEntry(previous, current)) {
        changes.push({ path, status: 'modified', before: previous, after: current });
      }
    }

    return changes;
  }

  private authorize(operation: LeaseOperation): void {
    this.ensureLeaseActive();
    if (!this.allowedOperations.has(operation)) {
      throw new CageBridgeError(`lease does not allow ${operation}`, 'OPERATION_DENIED');
    }
  }

  private ensureLeaseActive(): void {
    if (this.clock().getTime() >= this.expiresAt) {
      throw new CageBridgeError('lease has expired', 'LEASE_EXPIRED');
    }
  }

  private async loadRootRealPath(): Promise<string> {
    try {
      const root = await realpath(this.workspaceRoot);
      const info = await lstat(root);
      if (!info.isDirectory()) {
        throw new CageBridgeError('lease workspaceRoot must be a directory', 'INVALID_LEASE');
      }
      return root;
    } catch (error) {
      if (error instanceof CageBridgeError) throw error;
      throw new CageBridgeError('lease workspaceRoot is not an existing directory', 'INVALID_LEASE');
    }
  }

  private normalizeRelativePath(input: string): string {
    if (typeof input !== 'string' || input.includes('\0')) {
      throw new CageBridgeError('path must be a valid relative string', 'INVALID_PATH');
    }

    const slashPath = input.replaceAll('\\', '/');
    if (posix.isAbsolute(slashPath) || win32.isAbsolute(input) || win32.isAbsolute(slashPath)) {
      throw new CageBridgeError('absolute paths are not allowed', 'INVALID_PATH');
    }

    if (slashPath.split('/').some((segment) => segment === '..')) {
      throw new CageBridgeError('path traversal is not allowed', 'INVALID_PATH');
    }

    const normalized = posix.normalize(slashPath || '.');
    if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
      throw new CageBridgeError('path traversal is not allowed', 'INVALID_PATH');
    }
    return normalized;
  }

  private async secureExistingPath(input: string): Promise<string> {
    const filePath = resolve(this.workspaceRoot, this.normalizeRelativePath(input));
    const root = await this.rootRealPathPromise;
    let target: string;
    try {
      target = await realpath(filePath);
    } catch (error) {
      if (this.isErrno(error, 'ENOENT')) {
        throw new CageBridgeError(`path does not exist: ${input}`, 'PATH_NOT_FOUND');
      }
      throw error;
    }
    this.assertInside(root, target);
    return filePath;
  }

  private async secureWritePath(input: string): Promise<string> {
    const filePath = resolve(this.workspaceRoot, this.normalizeRelativePath(input));
    const root = await this.rootRealPathPromise;

    try {
      await lstat(filePath);
      const target = await realpath(filePath);
      this.assertInside(root, target);
      return filePath;
    } catch (error) {
      if (!this.isErrno(error, 'ENOENT')) throw error;
    }

    let parent = dirname(filePath);
    while (true) {
      try {
        const target = await realpath(parent);
        this.assertInside(root, target);
        return filePath;
      } catch (error) {
        if (!this.isErrno(error, 'ENOENT')) throw error;
        const next = dirname(parent);
        if (next === parent) {
          throw new CageBridgeError(`parent path does not exist: ${input}`, 'PATH_NOT_FOUND');
        }
        parent = next;
      }
    }
  }

  private assertInside(root: string, target: string): void {
    const remainder = relative(root, target);
    if (remainder === '..' || remainder.startsWith('../') || remainder.startsWith('..\\') || remainder.includes('\0')) {
      throw new CageBridgeError('path escapes the selected workspace', 'PATH_ESCAPE');
    }
  }

  private async describePath(filePath: string, path: string): Promise<WorkspaceEntry> {
    const root = await this.rootRealPathPromise;
    const target = await realpath(filePath).catch((error: unknown) => {
      if (this.isErrno(error, 'ENOENT')) {
        throw new CageBridgeError(`path does not exist: ${path}`, 'PATH_NOT_FOUND');
      }
      throw error;
    });
    this.assertInside(root, target);
    const info = await lstat(filePath);

    if (info.isSymbolicLink()) return { path, kind: 'symlink', size: info.size };
    if (info.isDirectory()) return { path, kind: 'directory', size: 0 };
    if (info.isFile()) {
      const content = await readFile(filePath);
      return {
        path,
        kind: 'file',
        size: info.size,
        sha256: createHash('sha256').update(content).digest('hex')
      };
    }
    throw new CageBridgeError(`unsupported filesystem entry: ${path}`, 'UNSUPPORTED_ENTRY');
  }

  private async snapshot(): Promise<WorkspaceEntry[]> {
    const root = await this.secureExistingPath('.');
    const entries: WorkspaceEntry[] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        const childPath = join(directory, child.name);
        const relativePath = prefix === '.' ? child.name : `${prefix}/${child.name}`;
        const entry = await this.describePath(childPath, relativePath);
        entries.push(entry);
        if (entry.kind === 'directory') await visit(childPath, relativePath);
      }
    };
    await visit(root, '.');
    return entries;
  }

  private entryMap(entries: readonly WorkspaceEntry[]): Map<string, WorkspaceEntry> {
    const result = new Map<string, WorkspaceEntry>();
    for (const entry of entries) {
      const path = this.normalizeRelativePath(entry.path);
      if (path === '.') continue;
      result.set(path, { ...entry, path });
    }
    return result;
  }

  private sameEntry(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
    return left.kind === right.kind && left.size === right.size && left.sha256 === right.sha256;
  }

  private isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  }
}
