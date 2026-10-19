import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const requiredFiles = [
  'AGENTS.md',
  'PLAN.md',
  'README.md',
  'docs/architecture.md',
  'docs/threat-model.md',
  'docs/demo-script.md',
  '.env.example',
  '.nvmrc',
  'Makefile',
  'Dockerfile'
];

for (const relativePath of requiredFiles) {
  await access(resolve(root, relativePath));
}

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const plan = await readFile(resolve(root, 'PLAN.md'), 'utf8');
const agents = await readFile(resolve(root, 'AGENTS.md'), 'utf8');

const requiredStatements = [
  ['README.md', readme, 'cageup opencode'],
  ['README.md', readme, 'ZK Key Injection'],
  ['PLAN.md', plan, 'Promotion scanner'],
  ['AGENTS.md', agents, 'CageBridge'],
  ['AGENTS.md', agents, 'make test']
];

for (const [file, content, statement] of requiredStatements) {
  if (!content.includes(statement)) {
    throw new Error(`${file} is missing required statement: ${statement}`);
  }
}

console.log(`Documentation scaffold verified: ${requiredFiles.length} required files present.`);
