import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';

export const name = 'ns-ocr-bridge';
export const inject = ['llm', 'credentials'];

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT = 3;
const MAX_REPLAY_CACHE = 256;
const PROVIDER_READY_TIMEOUT_MS = 12_000;
const EXTRA_PROVIDER_WAIT_MS = 3_000;
const CALL_TIMEOUT_MS = 120_000;

const CANDIDATE_ROUTES = [
  { provider: 'google-antigravity', model: 'antigravity-gemini-4-hydrogen', effort: 'low' },
  { provider: 'openai-codex', model: 'gpt-6-luna', effort: 'low' },
];

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return async function acquire(signal) {
    if (signal?.aborted) throw new Error('Request aborted before acquiring slot');
    if (active < limit) {
      active += 1;
    } else {
      await new Promise((resolveAcquire, rejectAcquire) => {
        const entry = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolveAcquire();
          },
        };
        const onAbort = () => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          rejectAcquire(new Error('Request aborted while queued'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(entry);
      });
      active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) next.resolve();
    };
  };
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.httpStatus = status;
      rejectBody(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        fail(413, 'Request body too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(400, err.message));
    req.on('aborted', () => fail(499, 'Client aborted request'));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object');
          err.httpStatus = 400;
          rejectBody(err);
          return;
        }
        resolveBody(parsed);
      } catch {
        const err = new Error('Invalid JSON body');
        err.httpStatus = 400;
        rejectBody(err);
      }
    });
  });
}

function computeHistoryPrefixDigest(systemParts, priorMessages) {
  const canonical = priorMessages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
  }));
  return createHash('sha256').update(JSON.stringify({ systemParts, canonical })).digest('hex');
}

function buildDshInput(body, route, assistantReplayCache) {
  const systemParts = [];
  const messages = [];
  for (const rawMsg of body.messages) {
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const role = String(rawMsg.role || '').trim();
    if (role === 'system' || role === 'developer') {
      const text = extractText(rawMsg.content);
      if (text.trim()) systemParts.push(text);
    } else if (role === 'user') {
      const text = extractText(rawMsg.content);
      messages.push(createUserMessage({ content: [{ type: 'text', text: text || ' ' }], source: { kind: 'user' } }));
    } else if (role === 'assistant') {
      const rawCalls = Array.isArray(rawMsg.tool_calls) ? rawMsg.tool_calls : [];
      const callIds = rawCalls.map((tc) => (typeof tc?.id === 'string' ? tc.id.trim() : ''));
      const uniqueNonEmptyIds = rawCalls.length > 0 && callIds.every(Boolean) && new Set(callIds).size === rawCalls.length;
      if (uniqueNonEmptyIds) {
        const prefixDigest = computeHistoryPrefixDigest(systemParts, messages);
        const cacheKey = JSON.stringify([prefixDigest, callIds]);
        const callSignature = JSON.stringify(
          rawCalls.map((tc) => [
            String(tc.id),
            String(tc.function?.name || ''),
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
          ]),
        );
        const cached = assistantReplayCache.get(cacheKey);
        if (
          cached &&
          cached.provider === route.provider &&
          cached.model === route.model &&
          cached.callSignature === callSignature
        ) {
          messages.push(cached.message);
          continue;
        }
      }
      const blocks = [];
      const text = extractText(rawMsg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of rawCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = tc.function && typeof tc.function === 'object' ? tc.function : {};
        blocks.push({
          type: 'tool-call',
          id: String(tc.id || randomUUID()),
          name: String(fn.name || ''),
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      messages.push(
        createAssistantMessage({
          content: blocks,
          source: { provider: route.provider, model: route.model },
        }),
      );
    } else if (role === 'tool') {
      const text = extractText(rawMsg.content);
      messages.push(
        createToolResultMessage({
          callId: String(rawMsg.tool_call_id || ''),
          content: [{ type: 'text', text: text || '(empty)' }],
          isError: false,
        }),
      );
    }
  }

  const tools = [];
  if (body.tool_choice !== 'none' && Array.isArray(body.tools)) {
    for (const item of body.tools) {
      const fn = item?.type === 'function' ? item.function : item;
      if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name.trim()) continue;
      tools.push({
        name: fn.name.trim(),
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      });
    }
  }

  const rawMax = body.max_completion_tokens ?? body.max_tokens;
  let maxTokens = 8192;
  if (rawMax !== undefined && rawMax !== null) {
    const requestedTokens = Number(rawMax);
    if (!Number.isInteger(requestedTokens) || requestedTokens <= 0) {
      const err = new Error('max_tokens/max_completion_tokens must be a positive integer');
      err.httpStatus = 400;
      throw err;
    }
    maxTokens = Math.min(requestedTokens, 16384);
  }

  const prefixDigest = computeHistoryPrefixDigest(systemParts, messages);
  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages,
    prefixDigest,
    tools: tools.length ? tools : undefined,
    maxTokens,
  };
}

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendSseCompletion(res, { completionId, created, model, contentText, toolCalls, finishReason, usage }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  const emit = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const baseDelta = { role: 'assistant' };
  if (contentText) baseDelta.content = contentText;
  if (toolCalls.length > 0) {
    baseDelta.tool_calls = toolCalls.map((tc, index) => ({ index, ...tc }));
  }
  emit({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: baseDelta, finish_reason: null }],
  });
  emit({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage,
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function waitForProviders(llm) {
  const deadline = Date.now() + PROVIDER_READY_TIMEOUT_MS;
  let firstSeenAt = 0;
  while (Date.now() < deadline) {
    const ids = new Set(llm.listProviders().map((p) => p.id));
    const readyCount = CANDIDATE_ROUTES.filter((r) => ids.has(r.provider)).length;
    if (readyCount === CANDIDATE_ROUTES.length) return ids;
    if (readyCount > 0) {
      if (!firstSeenAt) firstSeenAt = Date.now();
      if (Date.now() - firstSeenAt >= EXTRA_PROVIDER_WAIT_MS) return ids;
    }
    await delay(100);
  }
  return new Set(llm.listProviders().map((p) => p.id));
}

export async function apply(ctx, config = {}) {
  if (typeof config.token !== 'string' || config.token.length < 32) {
    throw new Error('ns-ocr-bridge requires a >= 32-char bearer token');
  }
  if (typeof config.handshakeSecret !== 'string' || config.handshakeSecret.length < 32) {
    throw new Error('ns-ocr-bridge requires a >= 32-char handshake secret');
  }
  if (typeof config.readyFile !== 'string' || !config.readyFile.trim()) {
    throw new Error('ns-ocr-bridge requires a valid readyFile path');
  }

  const expectedDigest = createHash('sha256').update(config.token).digest();
  await waitForProviders(ctx.llm);

  const acquireSlot = createSemaphore(MAX_CONCURRENT);
  const assistantReplayCache = new Map();
  let expectedHost = '';

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.origin !== undefined) {
        sendJson(res, 403, { error: { message: 'Origin header forbidden', type: 'auth_error' } });
        return;
      }
      if (!expectedHost || req.headers.host !== expectedHost) {
        sendJson(res, 403, { error: { message: 'Invalid Host header', type: 'auth_error' } });
        return;
      }

      const parsedReqUrl = new URL(req.url || '/', `http://${expectedHost}`);
      const urlPath = parsedReqUrl.pathname;
      // Ephemeral mutual HMAC challenge-response: caller must prove knowledge of handshakeSecret via `sig` before server returns `server:` tag.
      if (urlPath === '/_bridge_handshake') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error' } });
          return;
        }
        const challenge = parsedReqUrl.searchParams.get('c') || '';
        const clientSig = parsedReqUrl.searchParams.get('sig') || '';
        if (!/^[0-9a-f]{32}$/i.test(challenge) || !/^[0-9a-f]{64}$/i.test(clientSig)) {
          sendJson(res, 400, { error: { message: 'Invalid handshake parameters', type: 'invalid_request_error' } });
          return;
        }
        const expectedClientTag = createHmac('sha256', config.handshakeSecret).update(`client:${challenge}`).digest();
        if (!timingSafeEqual(Buffer.from(clientSig, 'hex'), expectedClientTag)) {
          sendJson(res, 401, { error: { message: 'Unauthorized handshake caller', type: 'auth_error' } });
          return;
        }
        const hmac = createHmac('sha256', config.handshakeSecret).update(`server:${challenge}`).digest('hex');
        sendJson(res, 200, { hmac });
        return;
      }

      const authMatch = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim());
      if (!authMatch) {
        sendJson(res, 401, { error: { message: 'Missing bearer token', type: 'auth_error' } });
        return;
      }
      const actualDigest = createHash('sha256').update(authMatch[1]).digest();
      if (!timingSafeEqual(actualDigest, expectedDigest)) {
        sendJson(res, 401, { error: { message: 'Invalid bearer token', type: 'auth_error' } });
        return;
      }
      if (urlPath === '/v1/models' || urlPath === '/models') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error' } });
          return;
        }
        const registered = new Set(ctx.llm.listProviders().map((p) => p.id));
        const available = CANDIDATE_ROUTES.filter((r) => registered.has(r.provider));
        if (available.length === 0) {
          sendJson(res, 503, { error: { message: 'No bridge providers currently registered', type: 'service_unavailable' } });
          return;
        }
        sendJson(res, 200, {
          object: 'list',
          data: available.map((r) => ({ id: r.model, object: 'model', owned_by: r.provider })),
        });
        return;
      }

      if (urlPath !== '/v1/chat/completions' && urlPath !== '/chat/completions') {
        sendJson(res, 404, { error: { message: 'Not found', type: 'not_found_error' } });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error' } });
        return;
      }

      const body = await readJsonBody(req, MAX_BODY_BYTES);
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendJson(res, 400, { error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' } });
        return;
      }

      const reqAbort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) reqAbort.abort();
      };
      res.on('close', onClose);

      let release;
      try {
        release = await acquireSlot(reqAbort.signal);
        const registered = new Set(ctx.llm.listProviders().map((p) => p.id));
        const activeRoutes = CANDIDATE_ROUTES.filter((r) => registered.has(r.provider));

        let completed = null;
        for (const route of activeRoutes) {
          if (reqAbort.signal.aborted) break;
          const dshInput = buildDshInput(body, route, assistantReplayCache);
          if (dshInput.messages.length === 0) continue;

          const assembler = new BlockAssembler();
          let rawUsage;
          try {
            const signal = AbortSignal.any([reqAbort.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
            for await (const chunk of ctx.llm.stream({
              provider: route.provider,
              model: route.model,
              reasoningEffort: route.effort,
              purpose: 'ns-ocr-bridge',
              ...(dshInput.system ? { system: dshInput.system } : {}),
              messages: dshInput.messages,
              ...(dshInput.tools ? { tools: dshInput.tools } : {}),
              maxTokens: dshInput.maxTokens,
              signal,
            })) {
              assembler.push(chunk);
              if (chunk.type === 'usage') rawUsage = chunk.usage;
            }
          } catch {
            continue;
          }

          if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
            continue;
          }

          const blocks = assembler.blocks();
          const contentText = blocks
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          const toolCalls = blocks
            .filter((b) => b.type === 'tool-call')
            .map((b) => ({
              id: String(b.id),
              type: 'function',
              function: {
                name: b.name,
                arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
              },
            }));

          const cacheIds = toolCalls.map((tc) => tc.id).filter(Boolean);
          if (toolCalls.length > 0 && cacheIds.length === toolCalls.length && new Set(cacheIds).size === toolCalls.length) {
            const cacheKey = JSON.stringify([dshInput.prefixDigest, cacheIds]);
            const callSignature = JSON.stringify(toolCalls.map((tc) => [tc.id, tc.function.name, tc.function.arguments]));
            if (assistantReplayCache.size >= MAX_REPLAY_CACHE) {
              const oldestKey = assistantReplayCache.keys().next().value;
              if (oldestKey !== undefined) assistantReplayCache.delete(oldestKey);
            }
            assistantReplayCache.set(cacheKey, {
              provider: route.provider,
              model: route.model,
              callSignature,
              message: assembler.message({
                provider: route.provider,
                model: route.model,
                ...(assembler.replayState ? { replayState: assembler.replayState } : {}),
              }),
            });
          }

          // Per @deepseek-ai/dsh-llm TokenUsage contract, inputTokens excludes cacheRead/cacheWrite (counts are disjoint).
          const promptTokens = Number(rawUsage?.inputTokens ?? 0) + Number(rawUsage?.cacheReadTokens ?? 0) + Number(rawUsage?.cacheWriteTokens ?? 0);
          const completionTokens = Number(rawUsage?.outputTokens ?? 0) + Number(rawUsage?.reasoningTokens ?? 0);
          completed = {
            model: route.model,
            contentText,
            toolCalls,
            finishReason: toolCalls.length > 0 ? 'tool_calls' : assembler.finish.kind === 'max-tokens' ? 'length' : 'stop',
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: Number(rawUsage?.totalTokens ?? promptTokens + completionTokens),
            },
          };
          break;
        }

        if (reqAbort.signal.aborted || res.destroyed) return;
        if (!completed) {
          sendJson(res, 502, { error: { message: 'All configured DSH bridge routes failed', type: 'upstream_error' } });
          return;
        }

        const completionId = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        if (body.stream === true) {
          sendSseCompletion(res, { completionId, created, ...completed });
        } else {
          sendJson(res, 200, {
            id: completionId,
            object: 'chat.completion',
            created,
            model: completed.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: completed.contentText || (completed.toolCalls.length > 0 ? null : ''),
                  ...(completed.toolCalls.length > 0 ? { tool_calls: completed.toolCalls } : {}),
                },
                finish_reason: completed.finishReason,
              },
            ],
            usage: completed.usage,
          });
        }
      } finally {
        res.off('close', onClose);
        if (release) release();
      }
    } catch (err) {
      const status = typeof err?.httpStatus === 'number' && err.httpStatus >= 400 && err.httpStatus < 500 ? err.httpStatus : 500;
      const msg = status < 500 && err instanceof Error ? err.message : 'Internal bridge error';
      sendJson(res, status, { error: { message: msg, type: 'bridge_error' } });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string' || addr.port <= 0) {
    server.close();
    throw new Error('Failed to bind loopback port for ns-ocr-bridge');
  }
  expectedHost = `127.0.0.1:${addr.port}`;

  ctx.on('dispose', () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });

  const payload = {
    port: addr.port,
    providers: ctx.llm.listProviders().map((p) => p.id),
  };
  await writeFile(`${config.readyFile}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(`${config.readyFile}.tmp`, config.readyFile);
}
