#!/usr/bin/env node

const [command] = process.argv.slice(2);

if (command === 'doctor') {
  console.log('CageUP doctor: package entrypoint is installed. Runtime providers are not implemented yet.');
  process.exit(0);
}

if (command === 'opencode') {
  console.error('CageUP opencode: the Daytona runtime and CageBridge are planned, but not implemented yet.');
  process.exit(2);
}

console.log('Usage: cageup <doctor|opencode>');
process.exit(command ? 1 : 0);
