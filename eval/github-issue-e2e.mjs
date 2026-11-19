#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDshHeadless } from '../bench/cleanroom-compare.mjs';
import { KanbanStore } from '../plugins/board/dist/core/index.js';
import { createIsolatedWorktree, removeIsolatedWorktree, verifySnapshotTests } from '../plugins/team/dist/core/index.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GH_SMITFIRE = join(ROOT_DIR, 'scripts', 'gh-smitfire.mjs');
const RUN_OCR = join(ROOT_DIR, 'scripts', 'run-ocr.mjs');
const DSH_NATIVE_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const OUTPUT_PATH = join(ROOT_DIR, '.local', 'e2e', 'gate7-github-issue.json');
const REPO_SLUG = 'smitfire/ns-dsh-e2e-sandbox';

function ghSmitfire(kind, ...args) {
  return execFileSync(process.execPath, [GH_SMITFIRE, kind, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 45_000,
  }).trim();
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

const workDir = mkdtempSync(join(tmpdir(), 'ns-gate7-gh-'));
const runTag = randomUUID().slice(0, 8);
let worktree = null;
let issueNumber = null;
let board = null;
let issueClosed = false;

try {
  // 1. Ensure private sandbox repository exists under smitfire without altering global gh identity
  let repoExists = false;
  try {
    ghSmitfire('gh', 'repo', 'view', REPO_SLUG, '--json', 'name');
    repoExists = true;
  } catch {
    repoExists = false;
  }
  if (!repoExists) {
    ghSmitfire('gh', 'repo', 'create', REPO_SLUG, '--private', '--description', 'Ephemeral Gate 7 E2E sandbox for @smitfire/ns-dsh');
  }

  // 2. Push clean buggy seed fixture commit onto an isolated per-run sandbox branch
  const repoDir = join(workDir, 'repo');
  const seedBranch = `gate7-${runTag}`;
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'test'), { recursive: true });

  const pkgJson = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } });
  const testCode = `import assert from 'node:assert/strict';
import test from 'node:test';
import { clampRange } from '../src/clamp.mjs';

test('clampRange rejects NaN and swaps reversed bounds cleanly (${runTag})', () => {
  assert.equal(clampRange(5, 0, 10), 5);
  assert.equal(clampRange(-3, 0, 10), 0);
  assert.equal(clampRange(25, 0, 10), 10);
  assert.equal(clampRange(5, 10, 0), 5);
  assert.throws(() => clampRange(NaN, 0, 10), /finite/i);
  assert.throws(() => clampRange(5, Infinity, 10), /finite/i);
});
`;
  const buggySrc = `export function clampRange(val, min, max) {\n  return Math.min(max, Math.max(min, val));\n}\n`;

  writeFileSync(join(repoDir, 'package.json'), pkgJson, 'utf8');
  writeFileSync(join(repoDir, 'src', 'clamp.mjs'), buggySrc, 'utf8');
  writeFileSync(join(repoDir, 'test', 'clamp.test.mjs'), testCode, 'utf8');
  writeFileSync(join(repoDir, '.gitignore'), '.ns-dsh/\nnode_modules/\n', 'utf8');

  execFileSync('git', ['-C', repoDir, 'init', '-b', seedBranch], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'e2e@smitfire.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'ns-dsh E2E'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', `https://github.com/${REPO_SLUG}.git`], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `seed: gate7 fixture ${runTag}`], { stdio: 'ignore' });
  ghSmitfire('git', '-C', repoDir, 'push', '-u', 'origin', seedBranch);

  // 3. Create real GitHub Issue on smitfire/ns-dsh-e2e-sandbox
  const issueUrl = ghSmitfire(
    'gh',
    'issue',
    'create',
    '--repo',
    REPO_SLUG,
    '--title',
    `Fix clampRange finite-number validation (${runTag})`,
    '--body',
    `clampRange(val, min, max) in src/clamp.mjs fails on NaN/Infinity inputs and reversed min/max bounds.\nRun \`node --test test/clamp.test.mjs\` to reproduce. Fix src/clamp.mjs without editing tests or package.json.`,
  );
  const numMatch = issueUrl.match(/\/issues\/(\d+)/);
  assert.ok(numMatch, `Unexpected issue URL: ${issueUrl}`);
  issueNumber = Number(numMatch[1]);

  // 4. Import issue into @smitfire/board, claim & post GitHub claim comment
  board = new KanbanStore(join(workDir, 'board.db'));
  const cardId = `gh-${issueNumber}-${runTag}`;
  const proposed = board.proposeCard({
    id: cardId,
    title: `GH #${issueNumber}: Fix clampRange finite check`,
    description: issueUrl,
    owner: 'coder',
    writeScopes: ['src/clamp.mjs'],
  });
  board.moveCard({ cardId: proposed.card.id, toColumn: 'in_progress', actor: 'orchestrator', role: 'orchestrator' });

  const claimComment = `<!-- ns-dsh-claim:${cardId} -->\nClaimed by \`@smitfire/ns-dsh\` orchestrator (card \`${cardId}\`). Isolated worktree implementation & verification underway.`;
  ghSmitfire('gh', 'issue', 'comment', String(issueNumber), '--repo', REPO_SLUG, '--body', claimComment);

  // 5. Execute fix inside isolated git worktree + snapshot test + OCR + cross-family review
  worktree = createIsolatedWorktree(repoDir, cardId, join(workDir, 'worktrees'));
  const seedHead = execFileSync('git', ['-C', worktree.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pkgBefore = sha256(readFileSync(join(worktree.worktreePath, 'package.json'), 'utf8'));
  const testBefore = sha256(readFileSync(join(worktree.worktreePath, 'test', 'clamp.test.mjs'), 'utf8'));

  const fixRes = await runDshHeadless({
    dshHome: DSH_NATIVE_HOME,
    cwd: worktree.worktreePath,
    prompt: `Fix src/clamp.mjs so clampRange(val, min, max) throws a TypeError/Error mentioning "finite" if any argument is not Number.isFinite, normalizes swapped min > max bounds, and passes node --test test/clamp.test.mjs. Do not modify package.json or test/clamp.test.mjs.`,
    provider: 'google-antigravity',
    model: 'antigravity-gemini-4-hydrogen',
    reasoningEffort: 'low',
    label: 'gate7-gh-coder',
    unsetEnvKeys: ['NS_BOARD_DB_PATH'],
  });
  assert.equal(fixRes.exitCode, 0, `Agent failed fixing GitHub issue: ${fixRes.errorMessage || ''}`);

  const snapshot = verifySnapshotTests(worktree.worktreePath, 'node --test test/clamp.test.mjs', { timeoutMs: 30_000 });
  assert.equal(snapshot.passed, true, 'Snapshot acceptance test failed on GitHub issue fix');
  assert.equal(sha256(readFileSync(join(worktree.worktreePath, 'package.json'), 'utf8')), pkgBefore);
  assert.equal(sha256(readFileSync(join(worktree.worktreePath, 'test', 'clamp.test.mjs'), 'utf8')), testBefore);

  // Commit in worktree for clean OCR diff check
  execFileSync('git', ['-C', worktree.worktreePath, 'config', 'user.email', 'e2e@smitfire.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', worktree.worktreePath, 'config', 'user.name', 'ns-dsh E2E'], { stdio: 'ignore' });
  const dirtyWorktree = execFileSync('git', ['-C', worktree.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirtyWorktree.length > 0) {
    execFileSync('git', ['-C', worktree.worktreePath, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', worktree.worktreePath, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `fix: clampRange finite & bound ordering (#${issueNumber})`], { stdio: 'ignore' });
  }
  const fixHead = execFileSync('git', ['-C', worktree.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(fixHead, seedHead, 'Agent produced no changes for GitHub issue fix');

  const ocrRaw = execFileSync(process.execPath, [RUN_OCR, worktree.worktreePath, seedHead, 'low'], {
    encoding: 'utf8',
    timeout: 240_000,
  });
  const ocrReport = JSON.parse(ocrRaw);
  assert.equal(ocrReport.passed, true, `OCR failed on GH issue fix: ${ocrRaw}`);

  const fullDiff = execFileSync('git', ['-C', worktree.worktreePath, 'diff', `${seedHead}..HEAD`], { encoding: 'utf8' });
  assert.ok(fullDiff.length > 0 && fullDiff.length <= 16_000, `Unexpected Gate 7 diff size (${fullDiff.length} chars)`);
  const diff = fullDiff;
  const reviewRes = await runDshHeadless({
    dshHome: DSH_NATIVE_HOME,
    cwd: worktree.worktreePath,
    prompt: `Task specification: Fix src/clamp.mjs so clampRange(val, min, max) throws a TypeError/Error mentioning "finite" if any argument is not Number.isFinite, normalizes swapped min > max bounds, and passes node --test test/clamp.test.mjs.\n\nNote: node --test test/clamp.test.mjs and OCR review already PASSED. Review this fix diff for GitHub issue #${issueNumber} against the task specification (max 3 lines). Do not flag changes requested by the specification or speculate about out-of-spec inputs. Do NOT modify any files. Reply starting with APPROVED: if valid else BLOCKING: .\n\n${diff}`,
    provider: 'openai-codex',
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    label: 'gate7-gh-reviewer',
    extraEnv: { NS_BOARD_DB_PATH: ':memory:' },
  });
  assert.equal(reviewRes.exitCode, 0);
  assert.equal(/^\s*APPROVED:/i.test(reviewRes.responseText), true, `Expected APPROVED prefix, got: ${reviewRes.responseText.slice(0, 160)}`);
  assert.equal(/^\s*BLOCKING:/i.test(reviewRes.responseText), false);

  board.moveCard({ cardId, toColumn: 'done', actor: 'openai-codex', role: 'reviewer', reviewFindings: 0 });
  const handoffBody = `<!-- ns-dsh-handoff:${cardId} -->\nVerified fix at \`${fixHead}\`:\n- Snapshot test \`node --test test/clamp.test.mjs\`: PASS\n- OCR review: PASS (blocking=${ocrReport.blockingCount})\n- Cross-family review (\`openai-codex/gpt-6-luna\`): PASS\n- Board card \`${cardId}\`: \`done\``;
  ghSmitfire('gh', 'issue', 'comment', String(issueNumber), '--repo', REPO_SLUG, '--body', handoffBody);

  const viewed = JSON.parse(ghSmitfire('gh', 'issue', 'view', String(issueNumber), '--repo', REPO_SLUG, '--json', 'comments,url,state'));
  const hasClaim = viewed.comments.some((c) => c.body.includes(`ns-dsh-claim:${cardId}`));
  const hasHandoff = viewed.comments.some((c) => c.body.includes(`ns-dsh-handoff:${cardId}`));
  assert.ok(hasClaim && hasHandoff, 'GitHub issue comments did not record both claim and handoff');

  ghSmitfire('gh', 'issue', 'close', String(issueNumber), '--repo', REPO_SLUG, '--comment', 'E2E Gate 7 verified and closed.');
  issueClosed = true;
  board.close();
  board = null;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const report = {
    gate: 'gate7-github-issue-e2e',
    generatedAt: new Date().toISOString(),
    passed: true,
    repository: REPO_SLUG,
    issueNumber,
    issueUrl: viewed.url,
    fixHead,
    snapshotPassed: snapshot.passed,
    ocrPassed: ocrReport.passed,
    crossFamilyReviewPassed: true,
    unknownCalls: (fixRes.unknownCalls ?? 0) + (reviewRes.unknownCalls ?? 0),
    claimAndHandoffVerified: hasClaim && hasHandoff,
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    board?.close();
  } catch { /* ignore */ }
  if (issueNumber !== null && !issueClosed) {
    try {
      ghSmitfire('gh', 'issue', 'close', String(issueNumber), '--repo', REPO_SLUG, '--comment', 'Closed during Gate 7 teardown.');
    } catch { /* ignore */ }
  }
  if (worktree) {
    try {
      removeIsolatedWorktree(join(workDir, 'repo'), worktree.worktreePath, worktree.branch);
    } catch { /* ignore */ }
  }
  rmSync(workDir, { recursive: true, force: true });
}
