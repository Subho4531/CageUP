import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, lstat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
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
}

interface SimulatorState {
  readonly handle: SandboxHandle;
  readonly root: string;
  uploaded: boolean;
  destroyed: boolean;
}

export class SimulatorProvider implements SandboxProvider {
  private readonly states = new Map<string, SimulatorState>();
  private readonly options: { readonly tempRoot: string | undefined; readonly clock: () => Date; readonly idFactory: () => string };

  constructor(options: SimulatorOptions = {}) {
    this.options = {
      tempRoot: options.tempRoot,
      clock: options.clock ?? (() => new Date()),
      idFactory: options.idFactory ?? (() => randomUUID())
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
    this.states.set(handle.id, { handle, root, uploaded: false, destroyed: false });
    return handle;
  }

  async uploadWorkspace(handle: SandboxHandle, source: string): Promise<void> {
    const state = this.state(handle);
    if (state.uploaded) throw new Error('workspace has already been uploaded');
    const sourcePath = resolve(source);
    const sourceStats = await stat(sourcePath).catch(() => undefined);
    if (!sourceStats?.isDirectory()) throw new Error('workspace source must be an existing directory');
    await cp(sourcePath, state.root, { recursive: true, verbatimSymlinks: true, errorOnExist: false });
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
      const child = spawn(command, [...args], { cwd, shell: false, env: { ...process.env, CAGEUP_SIMULATOR: '1' } });
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
