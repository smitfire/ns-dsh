import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import { generateSwitchyardRoutesToml } from '../plugins/team/dist/core/index.js';
import * as flightRecorder from '../dist/telemetry/flight-recorder.js';
import { runUpgradeCanary, satisfiesDshPrereleaseRange } from '../dist/upgrade/canary.js';

const ROOT = resolve(import.meta.dirname, '..');

test('All 5 child plugins declare compatible DSH 0.2.2-rc.3 manifests and cordis patches', () => {
  const names = ['context', 'codemode', 'cuga', 'board', 'team'];
  for (const name of names) {
    const pkgPath = join(ROOT, 'plugins', name, 'package.json');
    assert.equal(existsSync(pkgPath), true, `missing ${pkgPath}`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name: string;
      engines?: { dsh?: string };
      dsh?: { bundle?: { patch?: string } };
      exports?: Record<string, unknown>;
    };
    assert.equal(pkg.name, `@smitfire/${name}`);
    assert.ok(pkg.engines?.dsh);
    assert.equal(satisfiesDshPrereleaseRange('0.2.2-rc.3', pkg.engines.dsh), true);
    assert.equal(satisfiesDshPrereleaseRange('0.2.2', pkg.engines.dsh), true);
    assert.equal(satisfiesDshPrereleaseRange('0.1.2-rc.1', pkg.engines.dsh), false);
    assert.ok(pkg.dsh?.bundle?.patch);
    assert.equal(existsSync(join(ROOT, 'plugins', name, pkg.dsh.bundle.patch)), true);
    assert.ok(pkg.exports?.['./mcp']);
  }
});

test('FlightRecorder captures step, direct vs PTC tool calls, and flushes telemetry snapshot cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-fr-test-'));
  const outPath = join(dir, 'telemetry.jsonl');
  const ctx = new Context();
  await ctx.plugin(ToolsService);
  const fiber = ctx.plugin(flightRecorder, { outputPath: outPath });
  await fiber;

  try {
    const fakeAgent = { session: { id: 'sess-fr-1' } } as never;
    ctx.emit('tools/result', { name: 'read', arguments: {} } as never, { isError: false, content: [] } as never);
    ctx.emit(
      'tools/result',
      { name: 'run_code', parent: Symbol('ptc') as never, agent: fakeAgent, arguments: {} } as never,
      { isError: false, content: [] } as never,
    );
    await ctx.waterfall(
      'agent/pre-step',
      {
        agent: fakeAgent,
        messages: [],
        turn: 1,
        step: 1,
        signal: AbortSignal.timeout(2000),
        modelSelection: { provider: 'openai-codex', model: 'gpt-6-luna' } as never,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    );
    ctx.emit('agent/turn-stopping', { agent: fakeAgent, turn: 1 } as never);

    const snap = ctx.nsFlightRecorder!.snapshot('sess-fr-1') as { directToolCalls: number; ptcToolCalls: number; steps: number };
    assert.equal(snap.steps, 1);
    assert.equal(snap.ptcToolCalls, 1);
    assert.equal(existsSync(outPath), true);
    const written = readFileSync(outPath, 'utf8');
    assert.match(written, /sess-fr-1/);
  } finally {
    await fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Canary dry-run validates all 5 plugins and Switchyard config generator stays valid', () => {
  const res = runUpgradeCanary({ workspaceRoot: ROOT, targetDshVersion: '0.2.2-rc.3', dryRun: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.checks.length, 5);
  const toml = generateSwitchyardRoutesToml();
  assert.match(toml, /\[router\]/);
  assert.match(toml, /strategy = "stage_router"/);
});
