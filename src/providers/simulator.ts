import { createHash, randomUUID } from 'node:crypto';
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  FileManifestEntry,
  RuntimeEvent,
  RunSpec,
  SandboxHandle,
  SandboxProvider,
  WorkspaceManifest
} from '../core/contracts.js';

interface SimulatorOptions {
  readonly tempRoot?: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

interface SimulatorState {
  readonly handle: SandboxHandle;
  readonly root: string;
  readonly workspaceRoot: string;
  uploaded: boolean;
  destroyed: boolean;
}

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SystemRoot',
  'WINDIR',
  'USERPROFILE',
  'ComSpec',
  'PATHEXT'
] as const;

export class SimulatorProvider implements SandboxProvider {
  private readonly states = new Map<string, SimulatorState>();
  private readonly options: {
    readonly tempRoot: string | undefined;
    readonly clock: () => Date;
    readonly idFactory: () => string;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  };

  constructor(options: SimulatorOptions = {}) {
    this.options = {
      tempRoot: options.tempRoot,
      clock: options.clock ?? (() => new Date()),
      idFactory: options.idFactory ?? (() => randomUUID()),
      env: options.env ?? process.env
    };
  }

  async createRun(spec: RunSpec): Promise<SandboxHandle> {
    if (spec.provider !== 'simulator') throw new Error('SimulatorProvider requires provider=simulator');
    if (!spec.workspaceRoot.trim()) throw new Error('workspaceRoot is required');
    if (!spec.command.trim()) throw new Error('command is required');

    const root = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'cageup-simulator-'));
    const handle: SandboxHandle = {
      provider: 'simulator',
      id: `simulator_${this.options.idFactory()}`,
      createdAt: this.options.clock().toISOString()
    };
    this.states.set(handle.id, { handle, root, workspaceRoot: resolve(spec.workspaceRoot), uploaded: false, destroyed: false });
    return handle;
  }

  async uploadWorkspace(handle: SandboxHandle, source: string): Promise<void> {
    const state = this.state(handle);
    if (state.uploaded) throw new Error('workspace has already been uploaded');
    const sourcePath = resolve(source);
    const sourceStats = await lstat(sourcePath).catch(() => undefined);
    if (sourceStats?.isSymbolicLink()) throw new Error('workspace upload does not support symlinks: .');
    if (!sourceStats?.isDirectory()) throw new Error('workspace source must be an existing directory');
    await copyWorkspace(sourcePath, state.root);
    state.uploaded = true;
  }

  async *execute(handle: SandboxHandle, command: string, args: readonly string[]): AsyncIterable<RuntimeEvent> {
    const state = this.state(handle);
    if (!state.uploaded) throw new Error('workspace must be uploaded before execution');
    if (!command.trim()) throw new Error('command is required');

    yield this.event(handle, 'COMMAND_STARTED', { command, argumentCount: args.length });
    const result = await this.run(command, args, state.root);
    if (result.exitCode === 0) {
      yield this.event(handle, 'COMMAND_EXITED', { command, exitCode: result.exitCode });
      return;
    }
    yield this.event(handle, 'COMMAND_FAILED', { command, exitCode: result.exitCode });
    throw new Error(`simulator command failed with exit code ${result.exitCode}`);
  }

  async collectWorkspace(handle: SandboxHandle): Promise<WorkspaceManifest> {
    const state = this.state(handle);
    if (!state.uploaded) throw new Error('workspace must be uploaded before collection');
    const entries = await this.manifestEntries(state.root);
    const canonical = JSON.stringify(entries);
    return {
      root: '/workspace/project',
      createdAt: this.options.clock().toISOString(),
      entries,
      hash: createHash('sha256').update(canonical).digest('hex')
    };
  }

  async exportWorkspace(handle: SandboxHandle, destination: string): Promise<void> {
    const state = this.state(handle);
    if (!state.uploaded) throw new Error('workspace must be uploaded before export');
    const destinationPath = resolve(destination);
    await assertNoSymlinkAncestors(destinationPath);
    const workspaceCanonical = await canonicalPath(state.workspaceRoot);
    const destinationCanonical = await canonicalPath(destinationPath);
    if (isWithin(workspaceCanonical, destinationCanonical)) {
      throw new Error('export destination must be outside the host workspace');
    }
    await rm(destinationPath, { recursive: true, force: true });
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(state.root, destinationPath, { recursive: true, verbatimSymlinks: true, errorOnExist: false });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const state = this.states.get(handle.id);
    if (!state || state.destroyed) return;
    state.destroyed = true;
    await rm(state.root, { recursive: true, force: true });
  }

  private state(handle: SandboxHandle): SimulatorState {
    const state = this.states.get(handle.id);
    if (!state || state.destroyed) throw new Error(`sandbox ${handle.id} is not available`);
    return state;
  }

  private event(handle: SandboxHandle, type: RuntimeEvent['type'], payload: Record<string, string | number | boolean>): RuntimeEvent {
    const body = JSON.stringify({ type, runId: handle.id, payload });
    return {
      id: randomUUID(),
      type,
      runId: handle.id,
      occurredAt: this.options.clock().toISOString(),
      payload,
      previousHash: null,
      hash: createHash('sha256').update(body).digest('hex')
    };
  }

  private run(command: string, args: readonly string[], cwd: string): Promise<{ exitCode: number }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        shell: false,
        env: safeEnvironment(this.options.env),
        stdio: ['ignore', 'ignore', 'ignore']
      });
      child.on('error', reject);
      child.on('close', (exitCode) => resolvePromise({ exitCode: exitCode ?? 1 }));
    });
  }

  private async manifestEntries(root: string): Promise<FileManifestEntry[]> {
    const entries: FileManifestEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const name of (await readdir(directory)).sort()) {
        const absolute = join(directory, name);
        const path = relative(root, absolute).replaceAll('\\', '/');
        const info = await lstat(absolute);
        if (info.isDirectory()) {
          entries.push({ path, kind: 'directory', size: 0 });
          await visit(absolute);
        } else if (info.isSymbolicLink()) {
          entries.push({ path, kind: 'symlink', size: 0 });
        } else if (info.isFile()) {
          const content = await readFile(absolute);
          entries.push({ path, kind: 'file', size: info.size, sha256: createHash('sha256').update(content).digest('hex') });
        }
      }
    };
    await visit(root);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function copyWorkspace(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await copyDirectoryContents(source, destination, '');
}

async function copyDirectoryContents(source: string, destination: string, relativeDirectory: string): Promise<void> {
  for (const name of (await readdir(source)).sort()) {
    const sourcePath = join(source, name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const destinationPath = join(destination, name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) {
      throw new Error(`workspace upload does not support symlinks: ${relativePath}`);
    }
    if (info.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyDirectoryContents(sourcePath, destinationPath, relativePath);
    } else if (info.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`workspace upload does not support special files: ${relativePath}`);
    }
  }
}

function safeEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CAGEUP_SIMULATOR: '1' };
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`export destination contains a symlinked path component: ${current}`);
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return resolve(path);
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate));
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(fromParent));
}
