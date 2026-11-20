import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm';

export const name = 'ns-qualify-probe';
export const inject = ['llm', 'credentials'];

function checkUsageDisjoint(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const fields = {};
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const val = usage[k];
    if (val === undefined) continue;
    if (!Number.isSafeInteger(val) || val < 0) return null;
    fields[k] = val;
  }
  if (!Number.isSafeInteger(fields.inputTokens) || !Number.isSafeInteger(fields.outputTokens)) return null;
  return fields;
}

async function waitForProvider(llm, providerId, timeoutMs = 15_000) {
  if (typeof llm.listProviders !== 'function') return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (llm.listProviders().some((p) => p.id === providerId)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Provider ${providerId} did not register within ${timeoutMs}ms`);
}

async function qualifyRoute(llm, route) {
  const nonce = randomUUID();
  const stages = {
    discovery: false,
    effort: false,
    streaming: false,
    toolCall: false,
    toolResult: false,
    usage: false,
    cancellation: false,
  };
  const totalUsage = {
    calls: 0,
    unknownCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };

  async function* trackedStream(options) {
    let seenUsage;
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'usage') seenUsage = chunk.usage;
        yield chunk;
      }
    } finally {
      totalUsage.calls += 1;
      const disjoint = checkUsageDisjoint(seenUsage);
      if (!disjoint) {
        totalUsage.unknownCalls += 1;
      } else {
        for (const [k, v] of Object.entries(disjoint)) totalUsage[k] += v;
      }
    }
  }

  try {
    await waitForProvider(llm, route.provider, 15_000);
    const model = await llm.resolveModelInfo(route.provider, route.model, AbortSignal.timeout(20_000));
    stages.discovery = model.id === route.model && model.provider === route.provider;
    stages.effort = Boolean(model.reasoning?.efforts?.some((e) => e.id === route.effort));
    if (!stages.discovery || !stages.effort) {
      throw new Error(`Model ${route.provider}/${route.model}#${route.effort} unavailable`);
    }

    const baseOpts = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.effort,
      purpose: 'qualification',
      sessionId: `ns-qualify-${nonce}`,
      maxTokens: 1024,
    };
    const tools = [
      {
        name: 'echo_probe',
        description: 'Return the exact supplied nonce string.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ];
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Call tool echo_probe with {"value":"${nonce}"}. After its tool result arrives, reply with that exact string.`,
          },
        ],
      },
    ];

    const assembler = new BlockAssembler();
    let finish;
    for await (const chunk of trackedStream({
      ...baseOpts,
      signal: AbortSignal.timeout(90_000),
      messages,
      tools,
    })) {
      assembler.push(chunk);
      if (chunk.type.endsWith('-delta')) stages.streaming = true;
      if (chunk.type === 'finish') finish = chunk;
    }
    if (finish?.reason?.kind === 'error') {
      throw finish.reason.failure ?? new Error('Stream 1 finished with error');
    }

    const call = assembler.blocks().find((b) => b.type === 'tool-call' && b.name === 'echo_probe');
    let parsedArgs = null;
    if (call) {
      if (typeof call.arguments === 'string') {
        try {
          parsedArgs = JSON.parse(call.arguments);
        } catch {
          parsedArgs = null;
        }
      } else if (call.arguments && typeof call.arguments === 'object') {
        parsedArgs = call.arguments;
      }
    }
    stages.toolCall = Boolean(parsedArgs && parsedArgs.value === nonce);
    if (!stages.toolCall) {
      throw new Error('Model did not invoke echo_probe with exact UUID nonce');
    }

    messages.push(
      assembler.message({
        provider: route.provider,
        model: route.model,
        ...(assembler.replayState ? { replayState: assembler.replayState } : {}),
      }),
    );
    messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: nonce }] }));

    let finalOut = '';
    finish = undefined;
    for await (const chunk of trackedStream({
      ...baseOpts,
      signal: AbortSignal.timeout(90_000),
      messages,
      tools,
    })) {
      if (chunk.type === 'text-delta') finalOut += chunk.text;
      if (chunk.type === 'finish') finish = chunk;
    }
    if (finish?.reason?.kind === 'error') {
      throw finish.reason.failure ?? new Error('Stream 2 finished with error');
    }
    stages.toolResult = finalOut.includes(nonce) && finish?.reason?.kind === 'stop';
    stages.usage = totalUsage.calls >= 2 && totalUsage.unknownCalls === 0;

    // Immediate & bounded cancellation check (< 5000 ms)
    const cancelStarted = performance.now();
    const ac = new AbortController();
    ac.abort();
    let abortedFinish = false;
    try {
      for await (const chunk of llm.stream({
        ...baseOpts,
        signal: ac.signal,
        messages: messages.slice(0, 1),
        tools: [],
      })) {
        if (chunk.type === 'finish') {
          abortedFinish = chunk.reason?.kind === 'aborted';
        }
      }
    } catch (cancelErr) {
      if (ac.signal.aborted && (cancelErr?.name === 'AbortError' || /abort/i.test(String(cancelErr?.message || cancelErr)))) {
        abortedFinish = true;
      } else {
        throw cancelErr;
      }
    }
    const cancelMs = Number((performance.now() - cancelStarted).toFixed(1));
    stages.cancellation = abortedFinish && cancelMs < 5000;

    return {
      id: route.id,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      passed: Object.values(stages).every((v) => v === true),
      stages,
      cancelMs,
      context: model.context ?? null,
      usage: totalUsage,
      measuredAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      id: route.id,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      passed: false,
      stages,
      usage: totalUsage,
      error: err instanceof Error ? err.message : String(err),
      measuredAt: new Date().toISOString(),
    };
  }
}

export async function apply(ctx, config = {}) {
  if (typeof config.resultFile !== 'string' || config.resultFile.trim().length === 0) {
    throw new Error('qualify-plugin requires a non-empty config.resultFile path');
  }
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const results = await Promise.all(routes.map((route) => qualifyRoute(ctx.llm, route)));
  const out = {
    generatedAt: new Date().toISOString(),
    passed: results.length > 0 && results.every((r) => r.passed),
    routes: results,
  };
  await writeFile(`${config.resultFile}.tmp`, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  await rename(`${config.resultFile}.tmp`, config.resultFile);
}
