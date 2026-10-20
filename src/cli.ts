#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './core/config.js';
import type { CageUpConfig } from './core/contracts.js';

const commands = ['doctor', 'config', 'status', 'policy', 'diff', 'review', 'promote', 'reject', 'revoke', 'rollback', 'opencode'] as const;
type Command = (typeof commands)[number];

const unavailableState = 'no live run state is available; this operator phase does not start a daemon or connect to a provider';

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

export function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
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
    case 'policy':
      printPolicy(env);
      return 0;
    case 'opencode':
      return runOpenCode(args);
    case 'status':
      printUnavailable('status', 'there is no persisted or connected run to inspect');
      return 0;
    case 'diff':
      printUnavailable('diff', 'a workspace manifest has not been collected');
      return 0;
    case 'review':
      printUnavailable('review', 'a promotion plan has not been collected');
      return 0;
    case 'promote':
      printUnavailable('promote', 'there are no reviewed changes to promote', 2);
      return 2;
    case 'reject':
      printUnavailable('reject', 'there are no staged changes to reject', 2);
      return 2;
    case 'revoke':
      printUnavailable('revoke', 'there is no active lease to revoke', 2);
      return 2;
    case 'rollback':
      printUnavailable('rollback', 'there is no active run to roll back', 2);
      return 2;
  }
}

function printUsage(error = false): void {
  const output = [
    'Usage: cageup <command> [options]',
    '',
    'Commands:',
    '  doctor                 Check local CLI and configuration readiness',
    '  config                 Print validated configuration with secrets redacted',
    '  status                 Show the active run state',
    '  policy                 Show the active capability policy',
    '  diff                   Show collected workspace changes',
    '  review                 Show promotion decisions and reasons',
    '  promote                Promote reviewed changes',
    '  reject                 Reject staged changes',
    '  revoke                 Revoke the active lease',
    '  rollback               Destroy the run and discard its output',
    '  opencode -- [args...]  Forward exact OpenCode arguments when a runtime is available',
    '',
    'Live provider state is opt-in and unavailable in this operator-only phase.'
  ].join('\n');
  (error ? process.stderr : process.stdout).write(`${output}\n`);
}

function printDoctor(env: NodeJS.ProcessEnv): void {
  const lines = [
    'CageUP doctor',
    '  CLI: ready',
    '  local state: not initialized (no daemon)',
    '  live provider: unavailable (no network or daemon required)'
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

function printPolicy(env: NodeJS.ProcessEnv): void {
  let provider = 'unavailable';
  try {
    provider = loadConfig(env).provider;
  } catch (error) {
    provider = `unavailable (${configErrorMessage(error)})`;
  }

  process.stdout.write([
    'CageUP policy',
    `  provider: ${provider}`,
    '  workspace scope: selected workspace only',
    '  host writes: blocked until promotion review',
    '  protected surfaces: quarantined for review',
    '  credentials: run-scoped placeholders only; substituted secrets are not logged',
    `  live state: ${unavailableState}`
  ].join('\n') + '\n');
}

function runOpenCode(args: readonly string[]): number {
  const invocation = parseOpenCodeInvocation(args);
  process.stderr.write(
    `CageUP opencode: runtime unavailable; ${invocation.args.length} argument(s) preserved for explicit forwarding after --.\n`
  );
  return 2;
}

function printUnavailable(command: string, detail: string, exitCode = 0): void {
  const suffix = exitCode === 0 ? '' : ' No action was taken.';
  process.stdout.write(`CageUP ${command}: unavailable — ${detail}; ${unavailableState}.${suffix}\n`);
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
