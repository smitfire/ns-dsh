#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { KanbanStore } from '../plugins/board/dist/core/index.js';
import { ForewispBridge } from '../plugins/context/dist/core/index.js';
import { backupProfileConfig } from '../dist/upgrade/canary.js';
import { childPath, readForewispEnvVar, readJevBudgetLedger, stopChildProcessGroup } from './_shared.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT_DIR, 'bin', 'ns-dsh.mjs');
const DSH_BIN = join(ROOT_DIR, 'node_modules', '.bin', 'dsh');
const FOREWISP_BIN = join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const OUTPUT_PATH = join(ROOT_DIR, '.local', 'e2e', 'gate8-rollback-ledger.json');
const CAP_PORT = 18796;
const CAP_URL = `http://127.0.0.1:${CAP_PORT}`;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function testSyntheticJevHardStop() {
  const realE2e = realpathSync(join(ROOT_DIR, '.local', 'e2e'));
  const sharedPath = join(realE2e, 'jev-budget.sqlite');
  assert.ok(existsSync(sharedPath), 'Shared JEV budget ledger missing');
  const sharedBefore = readJevBudgetLedger(FOREWISP_BIN, sharedPath);
  assert.equal(sharedBefore.blocked, false, 'Shared ledger must start unblocked');

  const workDir = mkdtempSync(join(tmpdir(), 'ns-gate8-cap-'));
  const realWork = realpathSync(workDir);
  const capDb = join(realWork, 'cap-test.sqlite');
  const corpusDb = join(realWork, 'cap-corpus.sqlite');
  const wsDir = join(realWork, 'workspace');
  mkdirSync(wsDir, { recursive: true });
  const initEnv = { ...process.env };
  delete initEnv.TYPESAFE_API_KEY;
  execFileSync(FOREWISP_BIN, ['budget-init', capDb, '1'], { env: initEnv, stdio: 'inherit', timeout: 15_000 });

  const typesafeKey = readForewispEnvVar(ROOT_DIR, 'TYPESAFE_API_KEY');
  const apiToken = randomBytes(24).toString('hex');
  let stderrTail = '';
  const child = spawn(FOREWISP_BIN, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: childPath(),
      HOME: homedir(),
      TMPDIR: tmpdir(),
      TYPESAFE_API_KEY: typesafeKey,
      FOREWISP_DECISION_PROVIDER: 'jev',
      FOREWISP_BUDGET_DB: capDb,
      FOREWISP_BUDGET_MICRODOLLARS: '1',
      FOREWISP_API_TOKEN: apiToken,
      FOREWISP_BIND: `127.0.0.1:${CAP_PORT}`,
      FOREWISP_DB: corpusDb,
    },
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  const safeStderr = () => stderrTail.replaceAll(typesafeKey, '[REDACTED]').replaceAll(apiToken, '[REDACTED]');

  try {
    const deadline = Date.now() + 10_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Isolated Forewisp cap server exited early (${child.exitCode ?? child.signalCode}): ${safeStderr()}`);
      }
      try {
        const h = await fetch(`${CAP_URL}/health`, { signal: AbortSignal.timeout(800) });
        if (h.ok) {
          const hJson = await h.json();
          if (hJson?.status === 'ok' && hJson?.strategy === 'jev') {
            const unauth = await fetch(`${CAP_URL}/v1/taxonomy/nodes`, { signal: AbortSignal.timeout(800) });
            const auth = await fetch(`${CAP_URL}/v1/taxonomy/nodes`, {
              headers: { authorization: `Bearer ${apiToken}` },
              signal: AbortSignal.timeout(800),
            });
            const authJson = auth.ok ? await auth.json() : null;
            if ((unauth.status === 401 || unauth.status === 403) && auth.ok && Array.isArray(authJson?.nodes)) {
              healthy = true;
              break;
            }
          }
        }
      } catch {
        /* waiting */
      }
      await delay(120);
    }
    assert.equal(healthy, true, `Isolated Forewisp cap server did not become healthy: ${safeStderr()}`);

    const headers = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' };
    const cRes = await fetch(`${CAP_URL}/v1/contributions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'memory',
        title: 'Synthetic cap test memory',
        content: 'Always verify constant-time digest comparison in auth middleware.',
        scope: 'private',
        applicability: 'timingSafeEqual auth middleware digest',
        source: 'ns-dsh://gate8-cap',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(cRes.status, 200);

    // Under 1 uUSD cap, pre-dispatch reservation fails closed with 429 provider_budget_exhausted and 0 uUSD charged
    const rRes = await fetch(`${CAP_URL}/v1/recall`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Fix timing side channel in auth digest middleware', kinds: ['memory'] }),
      signal: AbortSignal.timeout(25_000),
    });
    assert.equal(rRes.status, 429);
    const rBody = await rRes.json();
    assert.equal(rBody.error, 'provider_budget_exhausted');

    const capAfter = readJevBudgetLedger(FOREWISP_BIN, capDb);
    assert.equal(capAfter.charged_microdollars, 0, `Expected 0 uUSD leakage under 1 uUSD cap, got ${JSON.stringify(capAfter)}`);

    // Verify @smitfire/context degrades gracefully to local SQLite when daemon returns 429
    const bridge = new ForewispBridge({ workspaceRoot: wsDir, mode: 'auto', daemonUrl: CAP_URL, daemonToken: apiToken });
    try {
      await bridge.upsert({
        schema: 'forewisp.knowledge.v1',
        id: 'local-fallback-note',
        kind: 'memory',
        title: 'Local fallback safety note',
        summary: 'Fallback auth digest rule',
        body: 'Local fallback survives daemon budget cap gracefully.',
      });
      const fallbackRecall = await bridge.retrieve('auth digest fallback', 'gate8-sess');
      assert.ok(Array.isArray(fallbackRecall.offers));
      assert.ok(fallbackRecall.offers.length >= 1, 'Expected graceful local fallback recall offers under 429');
      const sharedAfter = readJevBudgetLedger(FOREWISP_BIN, sharedPath);
      assert.equal(sharedAfter.blocked, false, 'Shared JEV ledger was modified by isolated test');
      assert.equal(sharedAfter.charged_microdollars, sharedBefore.charged_microdollars);

      return {
        passed:
          rRes.status === 429 &&
          rBody.error === 'provider_budget_exhausted' &&
          capAfter.charged_microdollars === 0 &&
          fallbackRecall.offers.length >= 1 &&
          !sharedAfter.blocked,
        syntheticCapMicrodollars: capAfter.ceiling_microdollars,
        syntheticChargedMicrodollars: capAfter.charged_microdollars,
        hardStopHttpStatus: rRes.status,
        hardStopError: rBody.error,
        gracefulContextOffers: fallbackRecall.offers.length,
        sharedLedgerUnchanged: sharedAfter.charged_microdollars === sharedBefore.charged_microdollars && !sharedAfter.blocked,
      };
    } finally {
      bridge.close();
    }
  } finally {
    await stopChildProcessGroup(child);
    rmSync(realWork, { recursive: true, force: true });
  }
}

async function testUpgradeAndRollbackPreservation() {
  const workDir = mkdtempSync(join(tmpdir(), 'ns-gate8-rb-'));
  const fakeDshHome = join(workDir, 'dsh-home');
  const wsDir = join(workDir, 'workspace');
  mkdirSync(wsDir, { recursive: true });
  const env = { ...process.env, PATH: childPath(), NS_DSH_HOME: fakeDshHome, DSH_HOME: fakeDshHome };

  try {
    // 1. Install into isolated NS_DSH_HOME and verify canary dry-run + incompatible target reject
    execFileSync(process.execPath, [CLI_BIN, 'install'], { env, stdio: 'inherit', timeout: 120_000 });
    const dryJson = JSON.parse(
      execFileSync(process.execPath, [CLI_BIN, 'upgrade', '--dry-run'], { env, encoding: 'utf8', timeout: 60_000 }),
    );
    assert.equal(dryJson.ok, true);

    let rejectedIncompatible = false;
    try {
      execFileSync(process.execPath, [CLI_BIN, 'upgrade', '--target', '0.9.0', '--dry-run'], {
        env,
        stdio: 'ignore',
        timeout: 30_000,
      });
    } catch {
      rejectedIncompatible = true;
    }
    assert.equal(rejectedIncompatible, true, 'Incompatible target 0.9.0 should fail closed');

    // 2. Seed rich state (Board + Forewisp local DB)
    const board = new KanbanStore(join(wsDir, '.ns-dsh', 'board.db'));
    board.proposeCard({ id: 'g8-card-1', title: 'Preserve across rollback', owner: 'coder', writeScopes: ['src'] });
    board.addComment({ cardId: 'g8-card-1', author: 'human', role: 'human', kind: 'approval', body: 'Approved state checkpoint' });
    board.close();

    const fw = new ForewispBridge({ workspaceRoot: wsDir, mode: 'local' });
    await fw.upsert({
      schema: 'forewisp.knowledge.v1',
      id: 'g8-mem-1',
      kind: 'memory',
      title: 'Rollback Invariant',
      summary: 'State survives upgrade rollback',
      body: 'Preserve board and Forewisp memory across profile rollback.',
    });
    fw.close();

    // 3. Snapshot profile web config, simulate broken upgrade edit, then rollback
    const webProfileDir = join(fakeDshHome, 'profiles', 'web');
    const pkgPath = join(webProfileDir, 'package.json');
    const preSha = sha256File(pkgPath);
    backupProfileConfig(webProfileDir);
    writeFileSync(pkgPath, '{"brokenUpgrade":true}\n', 'utf8');
    assert.notEqual(sha256File(pkgPath), preSha);

    execFileSync(process.execPath, [CLI_BIN, 'rollback', '--profile', 'web'], { env, stdio: 'inherit', timeout: 20_000 });
    const postSha = sha256File(pkgPath);
    assert.equal(postSha, preSha, 'Profile package.json hash not restored on rollback');

    // 4. Verify dsh --dump-config + state preservation 100%
    const dumpOut = execFileSync(DSH_BIN, ['--profile', 'web', '--dump-config'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.ok(dumpOut.length > 0);

    const boardAfter = new KanbanStore(join(wsDir, '.ns-dsh', 'board.db'));
    const cardAfter = boardAfter.getCard('g8-card-1');
    const commentsAfter = boardAfter.getComments('g8-card-1');
    boardAfter.close();

    const fwAfter = new ForewispBridge({ workspaceRoot: wsDir, mode: 'local' });
    const recallAfter = await fwAfter.retrieve('Rollback Invariant', 'g8-check');
    fwAfter.close();

    const statePreserved = Boolean(cardAfter && commentsAfter.length === 1 && recallAfter.offers.some((o) => o.id === 'g8-mem-1'));
    assert.equal(statePreserved, true);

    return {
      passed: statePreserved && rejectedIncompatible && postSha === preSha,
      canaryDryRunOk: dryJson.ok,
      incompatibleTargetRejected: rejectedIncompatible,
      profileHashRestored: postSha === preSha,
      boardCardPreserved: Boolean(cardAfter),
      forewispMemoryPreserved: recallAfter.offers.some((o) => o.id === 'g8-mem-1'),
      dumpConfigSucceeded: true,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const syntheticCap = await testSyntheticJevHardStop();
const rollbackPreservation = await testUpgradeAndRollbackPreservation();
const report = {
  gate: 'gate8-rollback-and-ledger',
  generatedAt: new Date().toISOString(),
  passed: Boolean(syntheticCap.passed && rollbackPreservation.passed),
  syntheticCap,
  rollbackPreservation,
};
writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exit(1);
