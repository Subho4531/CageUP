import type { CageUpConfig, ProviderName } from './contracts.js';

const providers = new Set<ProviderName>(['simulator', 'daytona']);
const logLevels = new Set<CageUpConfig['logLevel']>(['silent', 'error', 'warn', 'info', 'debug']);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new ConfigError(`${name} is required`);
  }
  return value.trim();
}

function provider(value: string | undefined): ProviderName {
  const selected = value?.trim() || 'simulator';
  if (!providers.has(selected as ProviderName)) {
    throw new ConfigError(`CAGEUP_PROVIDER must be one of: ${[...providers].join(', ')}`);
  }
  return selected as ProviderName;
}

function logLevel(value: string | undefined): CageUpConfig['logLevel'] {
  const selected = value?.trim() || 'info';
  if (!logLevels.has(selected as CageUpConfig['logLevel'])) {
    throw new ConfigError(`CAGEUP_LOG_LEVEL must be one of: ${[...logLevels].join(', ')}`);
  }
  return selected as CageUpConfig['logLevel'];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CageUpConfig {
  const selectedProvider = provider(env.CAGEUP_PROVIDER);
  const config: CageUpConfig = {
    provider: selectedProvider,
    workspace: required(env.CAGEUP_WORKSPACE, 'CAGEUP_WORKSPACE'),
    zkGatewayUrl: required(env.CAGEUP_ZK_GATEWAY_URL, 'CAGEUP_ZK_GATEWAY_URL'),
    logLevel: logLevel(env.CAGEUP_LOG_LEVEL)
  };

  if (selectedProvider === 'daytona') {
    return {
      ...config,
      daytonaApiUrl: required(env.DAYTONA_API_URL, 'DAYTONA_API_URL'),
      daytonaApiToken: required(env.DAYTONA_API_TOKEN, 'DAYTONA_API_TOKEN')
    };
  }

  return config;
}
