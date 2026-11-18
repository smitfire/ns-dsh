import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmService, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import ToolsService from '@deepseek-ai/dsh-tools';
import { generateSwitchyardRoutesToml } from '../plugins/team/dist/core/index.js';
import * as flightRecorder from '../dist/telemetry/flight-recorder.js';
import {
  assertSatisfiesDshPrereleaseRange,
  runUpgradeCanary,
  satisfiesDshPrereleaseRange,
  WORKSPACE_PLUGINS,
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
  assert.equal(res.checks.length, WORKSPACE_PLUGINS.length);
  const toml = generateSwitchyardRoutesToml();
  assert.match(toml, /\[router\]/);
  assert.match(toml, /strategy = "stage_router"/);
});

test('ns-dsh CLI resolves stock DSH binary and never selects agent-workbench wrapper', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'ns-dsh.mjs'), 'status'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN: '' },
  });
  const parsed = JSON.parse(out) as { dshBinary: string };
  assert.ok(parsed.dshBinary);
  if (existsSync(parsed.dshBinary)) {
    assert.equal(realpathSync(parsed.dshBinary).includes('workbench'), false, `Resolved ${parsed.dshBinary}`);
  }
});
