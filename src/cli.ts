#!/usr/bin/env node

import { loadConfig, ConfigError } from './core/config.js';

const [command, ...args] = process.argv.slice(2);

if (command === 'doctor') {
  console.log('CageUP doctor: contracts and configuration loader are available.');
  process.exit(0);
}

if (command === 'opencode') {
  console.error(`CageUP opencode: runtime providers are not implemented yet. Arguments received: ${args.join(' ')}`);
  process.exit(2);
}

if (command === 'config') {
  try {
    const config = loadConfig();
    console.log(JSON.stringify({ ...config, daytonaApiToken: config.daytonaApiToken ? '[redacted]' : undefined }, null, 2));
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`CageUP configuration error: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

console.log('Usage: cageup <doctor|config|opencode>');
process.exit(command ? 1 : 0);
