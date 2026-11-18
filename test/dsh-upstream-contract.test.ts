import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmService, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import ToolsService from '@deepseek-ai/dsh-tools';
import { generateSwitchyardRoutesToml } from '../plugins/team/dist/core/index.js';
import * as flightRecorder from '../dist/telemetry/flight-recorder.js';
import {
  WORKSPACE_PLUGINS,
  assertSatisfiesDshPrereleaseRange,
  backupProfileConfig,
  cleanTempBackup,
  rollbackProfileConfig,
  runUpgradeCanary,
  satisfiesDshPrereleaseRange,
  writeJsonAtomicReport,
} from '../dist/upgrade/canary.js';

const ROOT = resolve(import.meta.dirname, '..');

test('All 6 child plugins declare compatible DSH 0.2.2-rc.3 manifests and cordis patches', () => {
  for (const name of WORKSPACE_PLUGINS) {
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
  const rootPatch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  const teamPatch = readFileSync(join(ROOT, 'plugins', 'team', 'cordis.patch.yml'), 'utf8');
  assert.match(rootPatch, /- id: plan-mode\s+disabled: true/);
  assert.match(rootPatch, /- id: tool-agent-team\s+disabled: true/);
  assert.match(teamPatch, /- id: plan-mode\s+disabled: true/);
});

test('FlightRecorder captures step, direct vs PTC tool calls, DSH TokenUsage, and flushes/evicts on dispose', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-fr-test-'));
  const outPath = join(dir, 'telemetry.jsonl');
  const ctx = new Context();
  await ctx.plugin(ToolsService);
  await ctx.plugin(LlmService);
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
    class MockAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if ((options as { purpose?: unknown }).purpose) {
          yield { type: 'usage', usage: { inputTokens: 9999, outputTokens: 9999 } };
        } else {
          yield {
            type: 'usage',
            usage: { inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50, reasoningTokens: 25, outputTokens: 80 },
          };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['google-antigravity', 'openai-codex'], new MockAdapter());
    for await (const _chunk of ctx.llm.stream({
      provider: 'google-antigravity',
      model: 'antigravity-gemini-3.8-flash',
      messages: [],
      sessionId: 'sess-fr-1' as never,
    })) { /* drain */ }
    for await (const _chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      messages: [],
      purpose: 'compaction' as never,
      sessionId: 'sess-fr-1' as never,
    })) { /* auxiliary call skipped */ }
    ctx.emit('agent/turn-stopping', { agent: fakeAgent, turn: 1 } as never);

    const snap = ctx.nsFlightRecorder!.snapshot('sess-fr-1') as {
      directToolCalls: number;
      ptcToolCalls: number;
      steps: number;
      inputTokens: number;
      uncachedInputTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      thinkingTokens: number;
      outputTokens: number;
      step1PromptTokens: number | null;
      orchestratorPlanHandoffs: number;
      orchestratorReplans: number;
      modelBreakdown: Record<string, { steps: number; inputTokens: number; outputTokens: number; thinkingTokens: number }>;
    };
    assert.equal(snap.steps, 1);
    assert.equal(snap.ptcToolCalls, 1);
    assert.equal(snap.uncachedInputTokens, 100);
    assert.equal(snap.cachedInputTokens, 400);
    assert.equal(snap.cacheWriteTokens, 50);
    assert.equal(snap.inputTokens, 550);
    assert.equal(snap.step1PromptTokens, 550);
    assert.equal(snap.thinkingTokens, 25);
    assert.equal(snap.outputTokens, 80);
    assert.equal(snap.orchestratorPlanHandoffs, 0);
    assert.equal(snap.orchestratorReplans, 0);
    assert.equal(snap.modelBreakdown['google-antigravity/antigravity-gemini-3.8-flash:default']?.steps, 1);
    assert.equal(snap.modelBreakdown['google-antigravity/antigravity-gemini-3.8-flash:default']?.inputTokens, 550);

    ctx.emit('agent/disposed', { agent: fakeAgent } as never);
    ctx.emit('agent/disposed', { agent: null } as never);
    assert.equal(existsSync(outPath), true);
    const written = readFileSync(outPath, 'utf8');
    assert.match(written, /sess-fr-1/);
  } finally {
    await fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Semver range matcher handles || unions, hyphen ranges, ^/~ bounds, and rejects malformed ranges', () => {
  assert.equal(satisfiesDshPrereleaseRange('0.2.5', '0.2.2 - 0.3.0'), true);
  assert.equal(satisfiesDshPrereleaseRange('0.3.1', '0.2.2 - 0.3.0'), false);
  assert.equal(satisfiesDshPrereleaseRange('0.4.1', '^0.2.2 || ^0.4.0'), true);
  assert.equal(satisfiesDshPrereleaseRange('0.3.0-0', '^0.2.2'), false);
  assert.equal(satisfiesDshPrereleaseRange('0.2.9', '~0.2.2'), true);
  assert.equal(satisfiesDshPrereleaseRange('0.3.0', '~0.2.2'), false);
  assert.throws(() => assertSatisfiesDshPrereleaseRange('0.2.2', '>=0.2.2 || '), /unsupported|empty/i);
});

test('Canary dry-run validates all 6 plugins and Switchyard config generator stays valid', () => {
  const res = runUpgradeCanary({ workspaceRoot: ROOT, targetDshVersion: '0.2.2-rc.3', dryRun: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.checks.length, 6);
  const toml = generateSwitchyardRoutesToml();
  assert.match(toml, /\[router\]/);
  assert.match(toml, /strategy = "stage_router"/);
});

test('ns-dsh CLI resolves stock DSH binary and never selects agent-workbench wrapper', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'ns-dsh.mjs'), 'status'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN: '' },
  });
  const parsed = JSON.parse(out) as { dshBinary: string; plugins: Array<{ name: string }> };
  assert.ok(parsed.dshBinary);
  assert.equal(parsed.plugins.length, 6);
  if (existsSync(parsed.dshBinary)) {
    assert.equal(realpathSync(parsed.dshBinary).includes('workbench'), false, `Resolved ${parsed.dshBinary}`);
  }
});

test('ns-dsh refuses reserved agent-workbench ports (7420 / 19222) and init exports MCP servers for plugins with standalone entrypoints', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ns-dsh-cli-test-'));
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [join(ROOT, 'bin', 'ns-dsh.mjs'), 'start', '--port', '7420', '--state-dir', tmpDir], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      /7420/,
    );
    execFileSync(process.execPath, [join(ROOT, 'bin', 'ns-dsh.mjs'), 'init', '--agy', '--out', tmpDir], {
      encoding: 'utf8',
    });
    const mcp = JSON.parse(readFileSync(join(tmpDir, 'ns-dsh.agy.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    for (const srv of ['ns-context', 'ns-codemode', 'ns-cuga', 'ns-board', 'ns-team', 'ns-tui']) {
      assert.ok(mcp.mcpServers[srv], `missing ${srv} in init output`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backupProfileConfig, rollbackProfileConfig, cleanTempBackup, writeJsonAtomicReport, and semver edge cases work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-dsh-canary-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"p1"}\n', 'utf8');
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: x\n', 'utf8');
    const bakDir = backupProfileConfig(dir);
    writeFileSync(join(dir, 'package.json'), '{"name":"mutated"}\n', 'utf8');
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: y\n', 'utf8');
    assert.equal(rollbackProfileConfig(dir), true);
    assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"p1"/);
    assert.match(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), /- id: x/);
    cleanTempBackup(bakDir);
    assert.equal(existsSync(bakDir), false);
    assert.equal(rollbackProfileConfig(dir), false);

    const repPath = join(dir, 'nested', 'report.json');
    writeJsonAtomicReport(repPath, { ok: true, count: 6 });
    assert.deepEqual(JSON.parse(readFileSync(repPath, 'utf8')), { ok: true, count: 6 });

    assert.equal(satisfiesDshPrereleaseRange('0.2.2-rc.1', '<0.2.2-rc.3 >0.2.1'), true);
    assert.equal(satisfiesDshPrereleaseRange('0.2.2-alpha.1', '>0.2.2-alpha.1'), false);
    assert.equal(satisfiesDshPrereleaseRange('0.0.2', '^0.0.2'), true);
    assert.equal(satisfiesDshPrereleaseRange('0.0.3', '^0.0.2'), false);
    assert.throws(() => assertSatisfiesDshPrereleaseRange('not-semver', '^0.2.2'));
    assert.throws(() => assertSatisfiesDshPrereleaseRange('0.2.2', '>=badver'));

    const incompatible = runUpgradeCanary({ workspaceRoot: ROOT, targetDshVersion: '0.9.0', dryRun: false });
    assert.equal(incompatible.ok, false);
    assert.equal(incompatible.checks.every((c) => !c.compatible), true);

    // Cover canary.js error branches: bad range, missing tsconfig.test.json, missing tsc, failing tsc, no test files, failing unit test
    const fakeNoTsc = join(dir, 'fake-no-tsc');
    mkdirSync(join(fakeNoTsc, 'plugins', 'context'), { recursive: true });
    mkdirSync(join(fakeNoTsc, 'plugins', 'codemode'), { recursive: true });
    writeFileSync(join(fakeNoTsc, 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(fakeNoTsc, 'plugins', 'context', 'package.json'), '{"engines":{"dsh":"|| bad"}}\n', 'utf8');
    writeFileSync(join(fakeNoTsc, 'plugins', 'codemode', 'package.json'), '{"engines":{"dsh":">=0.2.2-rc.3"}}\n', 'utf8');
    writeFileSync(join(fakeNoTsc, 'plugins', 'codemode', 'tsconfig.test.json'), '{}\n', 'utf8');
    const noTscRes = runUpgradeCanary({ workspaceRoot: fakeNoTsc, dryRun: true });
    assert.equal(noTscRes.ok, false);
    assert.match(noTscRes.checks[0].error ?? '', /unsupported engine range/);
    assert.match(noTscRes.checks[1].error ?? '', /missing tsc binary/);

    const fakeWithTsc = join(dir, 'fake-with-tsc');
    mkdirSync(join(fakeWithTsc, 'node_modules', '.bin'), { recursive: true });
    const rootTsc = join(fakeWithTsc, 'node_modules', '.bin', 'tsc');
    writeFileSync(rootTsc, '#!/bin/sh\necho "tsc simulated fail" >&2\nexit 1\n', 'utf8');
    chmodSync(rootTsc, 0o755);
    writeFileSync(join(fakeWithTsc, 'package.json'), '{}\n', 'utf8');

    // context uses local ok tsc + empty test/ dir -> hits local tsc + no test/*.test.ts
    mkdirSync(join(fakeWithTsc, 'plugins', 'context', 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(fakeWithTsc, 'plugins', 'context', 'test'), { recursive: true });
    const localTsc = join(fakeWithTsc, 'plugins', 'context', 'node_modules', '.bin', 'tsc');
    writeFileSync(localTsc, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(localTsc, 0o755);
    writeFileSync(join(fakeWithTsc, 'plugins', 'context', 'package.json'), '{"engines":{"dsh":">=0.2.2-rc.3"}}\n', 'utf8');
    writeFileSync(join(fakeWithTsc, 'plugins', 'context', 'tsconfig.test.json'), '{}\n', 'utf8');

    // codemode uses local ok tsc + failing node --test file -> hits unitTestsPassed === false
    mkdirSync(join(fakeWithTsc, 'plugins', 'codemode', 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(fakeWithTsc, 'plugins', 'codemode', 'test'), { recursive: true });
    const cmTsc = join(fakeWithTsc, 'plugins', 'codemode', 'node_modules', '.bin', 'tsc');
    writeFileSync(cmTsc, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(cmTsc, 0o755);
    writeFileSync(join(fakeWithTsc, 'plugins', 'codemode', 'package.json'), '{"type":"module","engines":{"dsh":">=0.2.2-rc.3"}}\n', 'utf8');
    writeFileSync(join(fakeWithTsc, 'plugins', 'codemode', 'tsconfig.test.json'), '{}\n', 'utf8');
    writeFileSync(
      join(fakeWithTsc, 'plugins', 'codemode', 'test', 'fail.test.ts'),
      "import test from 'node:test'; test('fail', () => { throw new Error('simulated unit fail'); });\n",
      'utf8',
    );

    // cuga falls back to failing rootTsc -> hits !typecheckPassed
    mkdirSync(join(fakeWithTsc, 'plugins', 'cuga'), { recursive: true });
    writeFileSync(join(fakeWithTsc, 'plugins', 'cuga', 'package.json'), '{"engines":{"dsh":">=0.2.2-rc.3"}}\n', 'utf8');
    writeFileSync(join(fakeWithTsc, 'plugins', 'cuga', 'tsconfig.test.json'), '{}\n', 'utf8');

    const withTscRes = runUpgradeCanary({ workspaceRoot: fakeWithTsc, dryRun: false, runUnitTests: true });
    assert.equal(withTscRes.ok, false);
    assert.equal(withTscRes.checks[0].unitTestsPassed, false);
    assert.equal(withTscRes.checks[1].unitTestsPassed, false);
    assert.equal(withTscRes.checks[2].typecheckPassed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
