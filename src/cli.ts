#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './core/config.js';
import type { CageUpConfig } from './core/contracts.js';
import {
  SessionError,
  SessionRecoveryError,
  SessionRuntime,
  type SessionRecord,
  type SessionStatus
} from './session.js';
import { DaytonaProvider } from './providers/daytona.js';
import { SimulatorProvider } from './providers/simulator.js';

const commands = ['doctor', 'config', 'status', 'policy', 'diff', 'review', 'promote', 'reject', 'revoke', 'rollback', 'opencode'] as const;
type Command = (typeof commands)[number];

const CURRENT_SESSION_FILE = 'current-session';

export interface OpenCodeInvocation {
  readonly command: 'opencode';
  readonly args: readonly string[];
}

/** Preserve the exact argument boundaries following the explicit `--` separator. */
export function parseOpenCodeInvocation(args: readonly string[]): OpenCodeInvocation {
  const separator = args.indexOf('--');
  return {
    command: 'opencode',
    args: [...(separator === -1 ? args : args.slice(separator + 1))]
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [rawCommand, ...args] = argv;

  if (!rawCommand || rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    printUsage();
    return 0;
  }

  if (!commands.includes(rawCommand as Command)) {
    printUsage(true);
    return 1;
  }

  const command = rawCommand as Command;
  switch (command) {
    case 'doctor':
      printDoctor(env);
      return 0;
    case 'config':
      return printConfig(env);
    case 'opencode':
      return runOpenCode(args, env);
    case 'status':
      return runSessionInspection(command, args, env, async (runtime, sessionId) => summarizeStatus(await runtime.status(sessionId)));
    case 'policy':
      return runSessionInspection(command, args, env, async (runtime, sessionId) => runtime.policy(sessionId));
    case 'diff':
      return runSessionInspection(command, args, env, async (runtime, sessionId) => ({
        sessionId,
        changes: (await runtime.diff(sessionId)).map((change) => ({
          path: change.path,
          kind: change.kind,
          ...(change.baseline?.sha256 ? { baselineSha256: change.baseline.sha256 } : {}),
          ...(change.result?.sha256 ? { resultSha256: change.result.sha256 } : {})
        }))
      }));
    case 'review':
      return runSessionInspection(command, args, env, async (runtime, sessionId) => ({
        sessionId,
        ...(await runtime.review(sessionId))
      }));
    case 'promote':
      return runPromote(args, env);
    case 'reject':
      return runReviewGatedAction(command, args, env);
    case 'revoke':
      return runSessionInspection(command, args, env, async (runtime, sessionId) => summarizeRecord(await runtime.revoke(sessionId)));
    case 'rollback':
      return runSessionInspection(command, args, env, async (runtime, sessionId) => summarizeRecord(await runtime.rollback(sessionId)));
  }
}

function printUsage(error = false): void {
  const output = [
    'Usage: cageup <command> [options]',
    '',
    'Commands:',
    '  doctor                 Check local CLI and configuration readiness',
    '  config                 Print validated configuration with secrets redacted',
    '  status [--session ID]  Show a persisted run state',
    '  policy [--session ID]  Show a persisted capability policy',
    '  diff [--session ID]    Show collected workspace changes',
    '  review [--session ID]  Show promotion decisions and reasons',
    '  promote [--session ID] [--path PATH]... [--all-allowed] Promote reviewed paths',
    '  reject [--session ID]  Review-gated rejection action',
    '  revoke [--session ID]  Revoke the active lease',
    '  rollback [--session ID] Destroy the run and discard its output',
    '  opencode -- [args...]  Run OpenCode in a local or selected provider session',
    '',
    'Session state is stored outside the workspace in CAGEUP_STATE_DIR or ~/.cageup.'
  ].join('\n');
  (error ? process.stderr : process.stdout).write(`${output}\n`);
}

function printDoctor(env: NodeJS.ProcessEnv): void {
  const lines = [
    'CageUP doctor',
    '  CLI: ready',
    '  local state: external session store (CAGEUP_STATE_DIR or ~/.cageup)',
    '  live provider: opt-in (simulator is offline; Daytona requires configuration)'
  ];

  try {
    const config = loadConfig(env);
    lines.push(`  configuration: valid (provider=${config.provider})`);
  } catch (error) {
    lines.push(`  configuration: unavailable (${configErrorMessage(error)})`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function printConfig(env: NodeJS.ProcessEnv): number {
  try {
    process.stdout.write(`${JSON.stringify(redactConfig(loadConfig(env)), null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`CageUP configuration error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

async function runOpenCode(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  let config: CageUpConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    process.stderr.write(`CageUP opencode: configuration error: ${configErrorMessage(error)}\n`);
    return 2;
  }

  const invocation = parseOpenCodeInvocation(args);
  const stateDir = stateDirectory(env);
  const command = env.CAGEUP_COMMAND?.trim() || env.CAGEUP_OPENCODE_COMMAND?.trim() || 'opencode';
  const runtime = new SessionRuntime({
    stateDir,
    providerFactory: (provider) => createProvider(provider, config)
  });

  try {
    const started = await runtime.start({
      workspaceRoot: config.workspace,
      provider: config.provider,
      command,
      commandArgs: invocation.args
    });
    const released = await runtime.release(started.id);
    await writeCurrentSession(stateDir, released.id);
    printJson(summarizeRecord(released));
    return 0;
  } catch (error) {
    if (error instanceof SessionError && error.sessionId) {
      await writeCurrentSession(stateDir, error.sessionId).catch(() => undefined);
    }
    printCommandError('opencode', error);
    return 2;
  }
}

async function runSessionInspection<T>(
  command: Exclude<Command, 'doctor' | 'config' | 'opencode' | 'promote' | 'reject'>,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  operation: (runtime: SessionRuntime, sessionId: string) => Promise<T>
): Promise<number> {
  try {
    const stateDir = stateDirectory(env);
    const sessionId = await resolveSessionId(args, stateDir);
    const value = await operation(new SessionRuntime({ stateDir }), sessionId);
    printJson(value);
    return 0;
  } catch (error) {
    printCommandError(command, error);
    return 2;
  }
}

async function runReviewGatedAction(command: 'promote' | 'reject', args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const stateDir = stateDirectory(env);
    const sessionId = await resolveSessionId(args, stateDir);
    const status = await new SessionRuntime({ stateDir }).status(sessionId);
    printJson({
      sessionId,
      action: command,
      result: 'blocked',
      reviewed: Boolean(status.review),
      hostWrites: false,
      reason: status.review
        ? 'host promotion integration is not enabled; no host writes were performed'
        : 'a persisted review is required before this action; no host writes were performed'
    });
    return 2;
  } catch (error) {
    printCommandError(command, error);
    return 2;
  }
}

async function runPromote(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const options = parsePromotionOptions(args);
    const stateDir = stateDirectory(env);
    const sessionId = options.sessionId ?? await resolveSessionId([], stateDir);
    const runtime = new SessionRuntime({ stateDir });
    const status = await runtime.status(sessionId);
    const structuralPaths = new Set([
      ...(status.baseline?.entries ?? []),
      ...(status.result?.entries ?? [])
    ].filter((entry) => entry.kind === 'directory').map((entry) => entry.path));
    const paths = options.allAllowed
      ? (status.review?.decisions
        .filter((decision) => decision.decision === 'allow' && !structuralPaths.has(decision.path))
        .map((decision) => decision.path) ?? [])
      : options.paths;
    if (paths.length === 0) {
      throw new SessionError('INVALID_REQUEST', options.allAllowed
        ? 'the persisted review contains no allowed paths to promote'
        : 'promote requires at least one --path or --all-allowed', sessionId);
    }

    const promoted = await runtime.promote(sessionId, paths);
    const promotedPaths = promoted.promotion?.receipt.promoted.map((decision) => decision.path) ?? [];
    printJson({
      sessionId,
      action: 'promote',
      result: 'promoted',
      hostWrites: promotedPaths.length > 0,
      promotedPaths,
      quarantinedPaths: promoted.review?.decisions.filter((decision) => decision.decision === 'quarantine').map((decision) => decision.path) ?? []
    });
    return 0;
  } catch (error) {
    printCommandError('promote', error);
    return 2;
  }
}

function createProvider(provider: CageUpConfig['provider'], config: CageUpConfig): SimulatorProvider | DaytonaProvider {
  if (provider === 'simulator') return new SimulatorProvider();
  const options: { apiUrl?: string; apiToken?: string } = {};
  if (config.daytonaApiUrl) options.apiUrl = config.daytonaApiUrl;
  if (config.daytonaApiToken) options.apiToken = config.daytonaApiToken;
  return new DaytonaProvider(options);
}

function stateDirectory(env: NodeJS.ProcessEnv): string {
  return resolve(env.CAGEUP_STATE_DIR?.trim() || join(homedir(), '.cageup'));
}

async function resolveSessionId(args: readonly string[], stateDir: string): Promise<string> {
  const explicit = parseSessionOption(args);
  if (explicit) return explicit;

  try {
    const value = (await readFile(join(stateDir, CURRENT_SESSION_FILE), 'utf8')).trim();
    if (!/^session_[A-Za-z0-9_-]+$/.test(value)) throw new Error('the current-session pointer is invalid');
    return value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new SessionError('SESSION_NOT_FOUND', 'no current session is recorded; run cageup opencode -- [args...] or pass --session <id>');
    }
    if (error instanceof SessionError) throw error;
    throw new SessionError('STATE_IO', 'the current-session pointer could not be read', undefined, { cause: error });
  }
}

function parseSessionOption(args: readonly string[]): string | undefined {
  let sessionId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--session') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new SessionError('INVALID_REQUEST', '--session requires a session id');
      sessionId = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--session=')) {
      const value = argument.slice('--session='.length);
      if (!value) throw new SessionError('INVALID_REQUEST', '--session requires a session id');
      sessionId = value;
      continue;
    }
    throw new SessionError('INVALID_REQUEST', `unknown option ${argument}`);
  }
  return sessionId;
}

interface PromotionOptions {
  readonly sessionId?: string;
  readonly paths: readonly string[];
  readonly allAllowed: boolean;
}

function parsePromotionOptions(args: readonly string[]): PromotionOptions {
  let sessionId: string | undefined;
  const paths: string[] = [];
  let allAllowed = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--session') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new SessionError('INVALID_REQUEST', '--session requires a session id');
      sessionId = value;
      index += 1;
    } else if (argument?.startsWith('--session=')) {
      const value = argument.slice('--session='.length);
      if (!value) throw new SessionError('INVALID_REQUEST', '--session requires a session id');
      sessionId = value;
    } else if (argument === '--path') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new SessionError('INVALID_REQUEST', '--path requires a relative path');
      paths.push(value);
      index += 1;
    } else if (argument?.startsWith('--path=')) {
      const value = argument.slice('--path='.length);
      if (!value) throw new SessionError('INVALID_REQUEST', '--path requires a relative path');
      paths.push(value);
    } else if (argument === '--all-allowed') {
      allAllowed = true;
    } else {
      throw new SessionError('INVALID_REQUEST', `unknown option ${argument}`);
    }
  }
  if (allAllowed && paths.length > 0) {
    throw new SessionError('INVALID_REQUEST', '--all-allowed cannot be combined with --path');
  }
  if (new Set(paths).size !== paths.length) {
    throw new SessionError('INVALID_REQUEST', 'repeatable --path values must be unique');
  }
  return { ...(sessionId ? { sessionId } : {}), paths, allAllowed };
}

async function writeCurrentSession(stateDir: string, sessionId: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, CURRENT_SESSION_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${sessionId}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function summarizeStatus(status: SessionStatus): Record<string, unknown> {
  return {
    ...summarizeRecord(status),
    runtimeAvailable: status.runtimeAvailable
  };
}

function summarizeRecord(record: SessionRecord): Record<string, unknown> {
  return {
    sessionId: record.id,
    state: record.state,
    provider: record.runtime.provider,
    availability: record.runtime.availability,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.runtime.sandboxId ? { sandboxId: record.runtime.sandboxId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.promotion ? {
      promotion: {
        status: record.promotion.status,
        updatedAt: record.promotion.updatedAt,
        promotedPaths: record.promotion.receipt.promoted.map((decision) => decision.path)
      }
    } : {}),
    ...(record.error ? { error: record.error } : {})
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printCommandError(command: string, error: unknown): void {
  const detail = error instanceof SessionRecoveryError
    ? error.message
    : error instanceof ConfigError
      ? `configuration error: ${error.message}`
      : error instanceof Error
        ? redactText(error.message)
        : redactText(String(error));
  process.stderr.write(`CageUP ${command}: ${detail}\n`);
}

function redactConfig(config: CageUpConfig): Record<string, string> {
  const redacted: Record<string, string> = {
    provider: config.provider,
    workspace: config.workspace,
    zkGatewayUrl: config.zkGatewayUrl,
    logLevel: config.logLevel
  };
  if (config.daytonaApiUrl) redacted.daytonaApiUrl = config.daytonaApiUrl;
  if (config.daytonaApiToken) redacted.daytonaApiToken = '[redacted]';
  return redacted;
}

function configErrorMessage(error: unknown): string {
  return error instanceof ConfigError ? error.message : 'configuration could not be validated';
}

function redactText(value: string): string {
  return value
    .replaceAll(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replaceAll(/(?:api[-_ ]?key|access[-_ ]?token|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replaceAll(/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9._-]+\b/gi, '[REDACTED]');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(`CageUP: ${redactText(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
