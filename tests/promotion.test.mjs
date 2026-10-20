import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import {
  classifyPromotionPath,
  createPromotionPlan,
  promotePromotion,
  rollbackPromotion,
  stagePromotion
} from '../dist/promotion.js';

async function fileEntry(root, path) {
  const content = await readFile(join(root, path));
  return {
    path,
    kind: 'file',
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  };
}

async function manifest(root, paths) {
  return {
    root: '/workspace/project',
    createdAt: new Date(0).toISOString(),
    entries: await Promise.all(paths.map((path) => fileEntry(root, path))),
    hash: 'fixture'
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cageup-promotion-test-'));
  const host = join(root, 'host');
  const result = join(root, 'result');
  const staging = join(root, 'staging');
  await mkdir(join(host, '.github', 'workflows'), { recursive: true });
  await mkdir(join(result, '.github', 'workflows'), { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(host, 'notes.txt'), 'baseline notes\n');
  await writeFile(join(result, 'notes.txt'), 'worker notes\n');
  await writeFile(join(host, '.github', 'workflows', 'ci.yml'), 'baseline ci\n');
  await writeFile(join(result, '.github', 'workflows', 'ci.yml'), 'worker ci\n');
  return { root, host, result, staging };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('plans changed files, hashes result content, and quarantines protected surfaces', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const baseline = await manifest(paths.host, ['notes.txt', '.github/workflows/ci.yml']);
  const result = await manifest(paths.result, ['notes.txt', '.github/workflows/ci.yml']);

  const plan = await createPromotionPlan({
    baseline,
    result,
    resultRoot: paths.result,
    hostRoot: paths.host
  });

  const notes = plan.decisions.find((decision) => decision.path === 'notes.txt');
  const workflow = plan.decisions.find((decision) => decision.path === '.github/workflows/ci.yml');
  assert.equal(notes?.decision, 'allow');
  assert.equal(notes?.sha256, result.entries.find((entry) => entry.path === 'notes.txt')?.sha256);
  assert.equal(workflow?.decision, 'quarantine');
  assert.match(workflow?.reasons.join(' ') ?? '', /CI\/CD/);
});


test('classifies every protected execution surface', () => {
  const cases = [
    ['.git/hooks/pre-commit', /Git hooks/],
    ['package.json', /package lifecycle scripts/],
    ['.bashrc', /shell\/PowerShell profiles/],
    ['.github/workflows/check.yml', /CI\/CD configuration/],
    ['Makefile', /build surface/],
    ['.vscode/settings.json', /IDE configuration/],
    ['mcp.json', /MCP configuration/],
    ['AGENTS.md', /agent configuration/]
  ];
  for (const [path, pattern] of cases) {
    assert.match(classifyPromotionPath(path).join(' '), pattern);
  }
});

test('stages outside the host, promotes reviewed allows only, and rolls back exactly', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const baseline = await manifest(paths.host, ['notes.txt', '.github/workflows/ci.yml']);
  const result = await manifest(paths.result, ['notes.txt', '.github/workflows/ci.yml']);
  const plan = await createPromotionPlan({ baseline, result, resultRoot: paths.result, hostRoot: paths.host });
  const defaultStaged = await stagePromotion(plan);
  assert.equal(relative(paths.host, defaultStaged.stageRoot).startsWith('..'), true);
  await rollbackPromotion(defaultStaged);
  const staged = await stagePromotion(plan, { stagingRoot: paths.staging });

  assert.equal(relative(paths.host, staged.stageRoot).startsWith('..'), true);
  const allow = plan.decisions.find((decision) => decision.path === 'notes.txt');
  const quarantine = plan.decisions.find((decision) => decision.path === '.github/workflows/ci.yml');
  assert.ok(allow);
  assert.ok(quarantine);

  const receipt = await promotePromotion(staged, [{ ...allow, reviewed: true }]);
  assert.equal(await readFile(join(paths.host, 'notes.txt'), 'utf8'), 'worker notes\n');
  assert.equal(await readFile(join(paths.host, '.github', 'workflows', 'ci.yml'), 'utf8'), 'baseline ci\n');
  assert.deepEqual(receipt.promoted.map((decision) => decision.path), ['notes.txt']);

  await rollbackPromotion(receipt);
  assert.equal(await readFile(join(paths.host, 'notes.txt'), 'utf8'), 'baseline notes\n');
  assert.equal(await readFile(join(paths.host, '.github', 'workflows', 'ci.yml'), 'utf8'), 'baseline ci\n');
  assert.equal(await exists(staged.stageRoot), false);

  const stagedAgain = await stagePromotion(plan, { stagingRoot: paths.staging });
  await promotePromotion(stagedAgain, [{ ...quarantine, reviewed: true }]);
  assert.equal(await readFile(join(paths.host, '.github', 'workflows', 'ci.yml'), 'utf8'), 'baseline ci\n');
  await rollbackPromotion(stagedAgain);
});

test('denies traversal paths and refuses a staging directory inside the host', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const baseline = await manifest(paths.host, ['notes.txt']);
  const result = {
    root: '/workspace/project',
    createdAt: new Date(0).toISOString(),
    entries: [{ path: '../escape.txt', kind: 'file', size: 1, sha256: 'not-used' }],
    hash: 'fixture'
  };
  const plan = await createPromotionPlan({ baseline, result, resultRoot: paths.result, hostRoot: paths.host });
  const denied = plan.decisions.find((decision) => decision.path === '../escape.txt');
  assert.equal(denied?.decision, 'deny');
  assert.match(denied?.reasons.join(' ') ?? '', /traversal/);
  await assert.rejects(
    () => stagePromotion(plan, { stagingRoot: paths.host }),
    /outside the host workspace/
  );
});
