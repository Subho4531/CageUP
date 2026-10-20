import { createHash } from 'node:crypto';
import {
  copyFile,
  readdir,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import type { FileManifestEntry, PromotionDecision, WorkspaceManifest } from './core/contracts.js';

export interface PromotionPlanInput {
  readonly baseline: WorkspaceManifest;
  readonly result: WorkspaceManifest;
  readonly resultRoot: string;
  readonly hostRoot: string;
}

export interface PromotionChange {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted';
  readonly baseline?: FileManifestEntry;
  readonly result?: FileManifestEntry;
}

export interface PromotionPlan {
  readonly baseline: WorkspaceManifest;
  readonly result: WorkspaceManifest;
  readonly resultRoot: string;
  readonly hostRoot: string;
  readonly changes: readonly PromotionChange[];
  readonly decisions: readonly PromotionDecision[];
}

export interface StagePromotionOptions {
  readonly stagingRoot?: string;
}

export interface StagedPromotionEntry {
  readonly path: string;
  readonly decision: PromotionDecision['decision'];
  readonly change: PromotionChange;
  readonly resultPath?: string;
  readonly backupPath?: string;
  readonly hostExisted: boolean;
}

export interface StagedPromotion {
  readonly plan: PromotionPlan;
  readonly stageRoot: string;
  readonly entries: readonly StagedPromotionEntry[];
}

export interface ReviewedPromotionDecision extends PromotionDecision {
  readonly reviewed: boolean;
}

export interface PromotionReceipt {
  readonly staged: StagedPromotion;
  readonly promoted: readonly ReviewedPromotionDecision[];
}

interface ParsedManifest {
  readonly entries: ReadonlyMap<string, FileManifestEntry>;
  readonly invalid: readonly PromotionDecision[];
}

interface FilesystemEntry {
  readonly kind: FileManifestEntry['kind'];
  readonly size: number;
  readonly sha256?: string;
}

const PROTECTED_SURFACES: ReadonlyArray<readonly [string, (path: string, basename: string) => boolean]> = [
  ['Git hooks', (path) => path === '.git/hooks' || path.startsWith('.git/hooks/')],
  ['package lifecycle scripts', (_path, basename) => basename === 'package.json'],
  [
    'shell/PowerShell profiles',
    (path, basename) =>
      new Set([
        '.bashrc',
        '.bash_profile',
        '.bash_login',
        '.profile',
        '.zshrc',
        '.zprofile',
        '.zlogin',
        '.kshrc',
        'config.fish',
        'profile',
        'profile.ps1',
        'microsoft.powershell_profile.ps1'
      ]).has(basename) ||
      path.includes('/.config/powershell/') ||
      path.includes('/powershell/')
  ],
  [
    'CI/CD configuration',
    (path, basename) =>
      path.startsWith('.github/workflows/') ||
      path === '.gitlab-ci.yml' ||
      path === '.travis.yml' ||
      path === 'azure-pipelines.yml' ||
      path === 'jenkinsfile' ||
      path.startsWith('.circleci/') ||
      path.startsWith('.buildkite/') ||
      path.startsWith('.ci/') ||
      basename === 'copilot-instructions.md'
  ],
  [
    'build surface',
    (path, basename) =>
      path === 'makefile' ||
      path === 'dockerfile' ||
      path.startsWith('build/') ||
      path.startsWith('dist/') ||
      basename.startsWith('build.') ||
      basename.startsWith('webpack.') ||
      basename.startsWith('vite.') ||
      basename.startsWith('rollup.') ||
      basename.startsWith('tsup.') ||
      basename.endsWith('.mk')
  ],
  [
    'IDE configuration',
    (path, basename) =>
      path.startsWith('.vscode/') ||
      path.startsWith('.idea/') ||
      path.startsWith('.devcontainer/') ||
      basename.endsWith('.code-workspace')
  ],
  [
    'MCP configuration',
    (path, basename) =>
      path === '.mcp.json' ||
      path === 'mcp.json' ||
      path.startsWith('.mcp/') ||
      path.startsWith('mcp/') ||
      basename.includes('mcp')
  ],
  [
    'agent configuration',
    (path, basename) =>
      path.startsWith('.opencode/') ||
      path.startsWith('.claude/') ||
      path.startsWith('.agents/') ||
      path.startsWith('.cageup/') ||
      path.startsWith('.cursor/') ||
      path.startsWith('.windsurf/') ||
      basename === 'agents.md' ||
      basename === 'claude.md' ||
      basename.startsWith('opencode.json') ||
      (basename.startsWith('agent') && basename.endsWith('.json'))
  ]
];

export async function createPromotionPlan(input: PromotionPlanInput): Promise<PromotionPlan> {
  const resultRoot = await existingDirectory(input.resultRoot, 'resultRoot');
  const hostRoot = await existingDirectory(input.hostRoot, 'hostRoot');
  const baseline = parseManifest(input.baseline);
  const result = parseManifest(input.result);
  const decisions: PromotionDecision[] = [...baseline.invalid, ...result.invalid];
  const changes: PromotionChange[] = [];
  const paths = new Set<string>([...baseline.entries.keys(), ...result.entries.keys()]);

  for (const path of [...paths].sort()) {
    const baselineEntry = baseline.entries.get(path);
    const resultEntry = result.entries.get(path);
    if (baselineEntry && resultEntry && sameManifestEntry(baselineEntry, resultEntry)) continue;

    const change: PromotionChange = {
      path,
      kind: baselineEntry ? (resultEntry ? 'modified' : 'deleted') : 'added',
      ...(baselineEntry ? { baseline: baselineEntry } : {}),
      ...(resultEntry ? { result: resultEntry } : {})
    };
    changes.push(change);
    decisions.push(await decisionForChange(change, resultRoot));
  }

  return {
    baseline: input.baseline,
    result: input.result,
    resultRoot,
    hostRoot,
    changes,
    decisions: decisions.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export async function stagePromotion(plan: PromotionPlan, options: StagePromotionOptions = {}): Promise<StagedPromotion> {
  const stageParent = await safeStagingParent(options.stagingRoot, plan.hostRoot);
  const stageRoot = await mkdtemp(join(stageParent, 'cageup-promotion-'));
  const resultStageRoot = join(stageRoot, 'result');
  const backupRoot = join(stageRoot, 'backup');
  await mkdir(resultStageRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const entries: StagedPromotionEntry[] = [];
  try {
    for (const change of plan.changes) {
      const decision = plan.decisions.find((candidate) => candidate.path === change.path);
      if (!decision || decision.decision === 'deny') continue;
      if (change.result?.kind !== 'file' && change.baseline?.kind !== 'file') continue;

      const hostPath = safeJoin(plan.hostRoot, change.path);
      const hostEntry = await readFilesystemEntry(hostPath);
      const backupPath = hostEntry ? safeJoin(backupRoot, change.path) : undefined;
      if (hostEntry) {
        await copyEntry(hostPath, backupPath as string, hostEntry.kind);
      }

      let resultPath: string | undefined;
      if (change.result) {
        resultPath = safeJoin(resultStageRoot, change.path);
        const actual = await readFilesystemEntry(safeJoin(plan.resultRoot, change.path));
        if (!actual || actual.kind !== change.result.kind || actual.kind === 'symlink') {
          throw new Error(`staged result changed after planning: ${change.path}`);
        }
        await copyEntry(safeJoin(plan.resultRoot, change.path), resultPath, actual.kind);
      }

      entries.push({
        path: change.path,
        decision: decision.decision,
        change,
        ...(resultPath ? { resultPath } : {}),
        ...(backupPath ? { backupPath } : {}),
        hostExisted: Boolean(hostEntry)
      });
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }

  return { plan, stageRoot, entries };
}

export async function promotePromotion(
  staged: StagedPromotion,
  reviewed: readonly ReviewedPromotionDecision[]
): Promise<PromotionReceipt> {
  const reviewByPath = new Map<string, ReviewedPromotionDecision>();
  for (const review of reviewed) {
    if (!review.reviewed || review.decision !== 'allow') continue;
    if (reviewByPath.has(review.path)) throw new Error(`duplicate promotion review: ${review.path}`);
    reviewByPath.set(review.path, review);
  }

  const selected = staged.entries.filter((entry) => reviewByPath.has(entry.path));
  for (const entry of selected) {
    const planDecision = staged.plan.decisions.find((decision) => decision.path === entry.path);
    const review = reviewByPath.get(entry.path) as ReviewedPromotionDecision;
    if (!planDecision || planDecision.decision !== 'allow' || entry.decision !== 'allow') {
      throw new Error(`only planned allow decisions may be promoted: ${entry.path}`);
    }
    if (review.sha256 !== planDecision.sha256 || review.path !== planDecision.path) {
      throw new Error(`promotion review does not match plan: ${entry.path}`);
    }
  }

  await verifyHostBaseline(staged.plan, selected);
  const applied: StagedPromotionEntry[] = [];
  try {
    for (const entry of [...selected].sort(promotionOrder)) {
      await applyEntry(staged.plan.hostRoot, entry);
      applied.push(entry);
    }
  } catch (error) {
    await restoreEntries(staged.plan.hostRoot, applied, staged.stageRoot);
    throw error;
  }

  return {
    staged,
    promoted: selected.map((entry) => reviewByPath.get(entry.path) as ReviewedPromotionDecision)
  };
}

export async function rollbackPromotion(target: StagedPromotion | PromotionReceipt): Promise<void> {
  const staged = 'staged' in target ? target.staged : target;
  const paths = new Set('staged' in target ? target.promoted.map((decision) => decision.path) : []);
  const entries = staged.entries.filter((entry) => paths.has(entry.path));
  await restoreEntries(staged.plan.hostRoot, entries, staged.stageRoot);
  await rm(staged.stageRoot, { recursive: true, force: true });
}

export function classifyPromotionPath(path: string): readonly string[] {
  const normalized = normalizeRelativePath(path);
  if (!normalized) return [];
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  return PROTECTED_SURFACES.filter(([, matches]) => matches(normalized.toLowerCase(), basename)).map(
    ([label]) => `protected execution surface: ${label}`
  );
}

async function decisionForChange(change: PromotionChange, resultRoot: string): Promise<PromotionDecision> {
  const protectionReasons = classifyPromotionPath(change.path);
  const invalidPath = normalizeRelativePath(change.path) === undefined;
  if (invalidPath) {
    return { path: change.path, decision: 'deny', reasons: ['path traversal or absolute path is not allowed'] };
  }
  if (change.result?.kind === 'symlink' || change.baseline?.kind === 'symlink') {
    return { path: change.path, decision: 'deny', reasons: ['symlink promotion is not allowed'] };
  }
  if (change.result?.kind === 'directory' || change.baseline?.kind === 'directory') {
    return {
      path: change.path,
      decision: 'deny',
      reasons: ['directory entries are structural; contained file changes must be reviewed individually']
    };
  }
  if (change.result?.kind === 'file') {
    const actualPath = safeJoin(resultRoot, change.path);
    const actual = await readFilesystemEntry(actualPath);
    if (!actual || actual.kind !== 'file') {
      return { path: change.path, decision: 'deny', reasons: ['result manifest does not match the result workspace'] };
    }
    if (change.result.sha256 && change.result.sha256 !== actual.sha256) {
      return {
        path: change.path,
        decision: 'deny',
        reasons: ['result manifest SHA-256 does not match the result workspace'],
        ...(actual.sha256 ? { sha256: actual.sha256 } : {})
      };
    }
    if (protectionReasons.length > 0) {
      return { path: change.path, decision: 'quarantine', reasons: protectionReasons, ...(actual.sha256 ? { sha256: actual.sha256 } : {}) };
    }
    return { path: change.path, decision: 'allow', reasons: ['changed file is outside protected execution surfaces'], ...(actual.sha256 ? { sha256: actual.sha256 } : {}) };
  }
  if (change.result?.kind === 'directory') {
    if (protectionReasons.length > 0) return { path: change.path, decision: 'quarantine', reasons: protectionReasons };
    return { path: change.path, decision: 'allow', reasons: ['directory change is outside protected execution surfaces'] };
  }
  if (protectionReasons.length > 0) return { path: change.path, decision: 'quarantine', reasons: protectionReasons };
  return { path: change.path, decision: 'allow', reasons: ['deletion is outside protected execution surfaces'] };
}

function parseManifest(manifest: WorkspaceManifest): ParsedManifest {
  const entries = new Map<string, FileManifestEntry>();
  const invalid: PromotionDecision[] = [];
  for (const entry of manifest.entries) {
    const normalized = normalizeRelativePath(entry.path);
    if (normalized === undefined) {
      invalid.push({ path: entry.path, decision: 'deny', reasons: ['path traversal or absolute path is not allowed'] });
      continue;
    }
    if (entries.has(normalized)) {
      invalid.push({ path: entry.path, decision: 'deny', reasons: ['duplicate manifest path is not allowed'] });
      continue;
    }
    entries.set(normalized, { ...entry, path: normalized });
  }
  return { entries, invalid };
}

function sameManifestEntry(left: FileManifestEntry, right: FileManifestEntry): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'file' || right.kind === 'file') {
    return left.kind === right.kind && left.size === right.size && Boolean(left.sha256) && left.sha256 === right.sha256;
  }
  return left.size === right.size;
}

function normalizeRelativePath(path: string): string | undefined {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || win32.isAbsolute(path)) return undefined;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return parts.join('/');
}

function safeJoin(root: string, path: string): string {
  const normalized = normalizeRelativePath(path);
  if (!normalized) throw new Error(`unsafe relative path: ${path}`);
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...normalized.split('/'));
  const fromRoot = relative(rootPath, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    throw new Error(`path escapes root: ${path}`);
  }
  return target;
}

async function existingDirectory(path: string, name: string): Promise<string> {
  const resolved = resolve(path);
  const info = await lstat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${name} must be an existing directory`);
  return realpath(resolved);
}

async function safeStagingParent(requested: string | undefined, hostRoot: string): Promise<string> {
  const host = await realpath(hostRoot);
  const parent = resolve(requested ?? tmpdir());
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  if (isWithin(host, actualParent)) {
    throw new Error('staging output must be outside the host workspace');
  }
  return actualParent;
}

function isWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate));
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(fromParent));
}

async function readFilesystemEntry(path: string): Promise<FilesystemEntry | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return { kind: 'symlink', size: 0 };
  if (info.isDirectory()) return { kind: 'directory', size: 0 };
  if (info.isFile()) return { kind: 'file', size: info.size, sha256: await hashFile(path) };
  return undefined;
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function copyEntry(source: string, destination: string, kind: FileManifestEntry['kind']): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (kind === 'file') {
    await copyFile(source, destination);
  } else if (kind === 'directory') {
    await copyDirectoryWithoutSymlinks(source, destination);
  } else {
    throw new Error(`cannot copy symlink entry: ${source}`);
  }
}

async function copyDirectoryWithoutSymlinks(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    const entry = await readFilesystemEntry(sourcePath);
    if (!entry || entry.kind === 'symlink') throw new Error(`directory contains unsupported entry: ${sourcePath}`);
    await copyEntry(sourcePath, destinationPath, entry.kind);
  }
}

async function verifyHostBaseline(plan: PromotionPlan, selected: readonly StagedPromotionEntry[]): Promise<void> {
  for (const staged of selected) {
    const expected = staged.change.baseline;
    const actual = await readFilesystemEntry(safeJoin(plan.hostRoot, staged.path));
    if (!expected && actual) throw new Error(`host changed since baseline: ${staged.path}`);
    if (expected && (!actual || expected.kind !== actual.kind || (expected.kind === 'file' && expected.sha256 && expected.sha256 !== actual.sha256))) {
      throw new Error(`host changed since baseline: ${staged.path}`);
    }
  }
}

async function applyEntry(hostRoot: string, entry: StagedPromotionEntry): Promise<void> {
  const hostPath = safeJoin(hostRoot, entry.path);
  await rm(hostPath, { recursive: true, force: true });
  if (entry.resultPath) {
    const kind = entry.change.result?.kind;
    if (!kind || kind === 'symlink') throw new Error(`cannot promote unsupported result: ${entry.path}`);
    await copyEntry(entry.resultPath, hostPath, kind);
  }
}

async function restoreEntries(hostRoot: string, entries: readonly StagedPromotionEntry[], stageRoot: string): Promise<void> {
  for (const entry of [...entries].sort((left, right) => pathDepth(right.path) - pathDepth(left.path))) {
    const hostPath = safeJoin(hostRoot, entry.path);
    await rm(hostPath, { recursive: true, force: true });
  }
  for (const entry of [...entries].sort((left, right) => pathDepth(left.path) - pathDepth(right.path))) {
    if (entry.backupPath) {
      const kind = entry.change.baseline?.kind;
      if (!kind || kind === 'symlink') throw new Error(`cannot restore unsupported original: ${entry.path}`);
      await copyEntry(entry.backupPath, safeJoin(hostRoot, entry.path), kind);
    }
  }
  if (entries.length === 0) await rm(stageRoot, { recursive: true, force: true });
}

function pathDepth(path: string): number {
  return path.split('/').length;
}

function promotionOrder(left: StagedPromotionEntry, right: StagedPromotionEntry): number {
  const leftDeleted = !left.change.result;
  const rightDeleted = !right.change.result;
  if (leftDeleted !== rightDeleted) return leftDeleted ? -1 : 1;
  return leftDeleted ? pathDepth(right.path) - pathDepth(left.path) : pathDepth(left.path) - pathDepth(right.path);
}
