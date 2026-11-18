import z from '@deepseek-ai/schemastery';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export const name = 'ns-flight-recorder';
export const Config = z.object({
    outputPath: z.string(),
});
export function apply(ctx, rawConfig = {}) {
    const applyStart = performance.now();
    const bootMs = Number(applyStart.toFixed(2));
    const outFile = rawConfig.outputPath || process.env.NS_DSH_TELEMETRY_PATH || '';
    const sessions = new Map();
    const turnStartTimes = new Map();
    const ensure = (sid) => {
        let st = sessions.get(sid);
        if (!st) {
            st = {
                sessionId: sid,
                bootMs,
                ttfrMs: null,
                wallMs: 0,
                turns: 0,
                steps: 0,
                directToolCalls: 0,
                ptcToolCalls: 0,
                step1PromptTokens: null,
                contextCurve: [],
                rawToolBytes: 0,
                admittedBytes: 0,
                ftsBytesSaved: 0,
                inputTokens: 0,
                uncachedInputTokens: 0,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                thinkingTokens: 0,
                outputTokens: 0,
                switchyardEscalations: 0,
                orchestratorPlanHandoffs: 0,
                orchestratorReplans: 0,
                modelBreakdown: {},
                advisorCalls: 0,
                peakRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
            };
            sessions.set(sid, st);
        }
        return st;
    };
    const syncDerivedMetrics = (st) => {
        const cm = ctx.get('nsCodemode');
        if (cm?.metrics) {
            const m = cm.metrics();
            st.rawToolBytes = m.rawToolBytes;
            st.admittedBytes = m.admittedBytes;
            st.ftsBytesSaved = Math.max(0, m.rawToolBytes - m.admittedBytes);
        }
        const team = ctx.get('nsTeam');
        if (team?.router?.stateFor) {
            st.switchyardEscalations = team.router.stateFor(st.sessionId).escalations;
        }
        if (team?.getOrchestratorState) {
            const ost = team.getOrchestratorState(st.sessionId);
            st.orchestratorPlanHandoffs = ost.planHandoffs ?? 0;
            st.orchestratorReplans = ost.replans ?? 0;
        }
        st.peakRssMb = Math.max(st.peakRssMb, Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)));
        return st;
    };
    const cloneRow = (s) => {
        const synced = syncDerivedMetrics(s);
        const clonedBreakdown = {};
        for (const [k, v] of Object.entries(synced.modelBreakdown)) {
            clonedBreakdown[k] = { ...v };
        }
        return { ...synced, contextCurve: [...synced.contextCurve], modelBreakdown: clonedBreakdown };
    };
    const flushToDisk = (targetPath = outFile) => {
        if (!targetPath)
            return null;
        try {
            const abs = resolve(targetPath);
            mkdirSync(dirname(abs), { recursive: true });
            const rows = [...sessions.values()].map(cloneRow);
            if (rows.length === 0)
                return null;
            appendFileSync(abs, `${JSON.stringify({ timestamp: Date.now(), telemetry: rows })}\n`, 'utf8');
            return abs;
        }
        catch {
            return null;
        }
    };
    ctx.provide('nsFlightRecorder', {
        bootStartedAt: applyStart,
        bootMs,
        snapshot: (sessionId) => {
            if (sessionId) {
                const existing = sessions.get(sessionId);
                return cloneRow(existing ?? ensure(sessionId));
            }
            return [...sessions.values()].map(cloneRow);
        },
        flushToDisk,
    });
    ctx.on('agent/disposed', ({ agent }) => {
        if (!agent?.session?.id)
            return;
        const sid = String(agent.session.id);
        turnStartTimes.delete(sid);
        // Persist completed session rows before evicting so memory stays bounded without losing telemetry.
        flushToDisk();
        sessions.delete(sid);
    });
    ctx.on('agent/pre-step', async (payload, next) => {
        if (!payload.agent?.session?.id)
            return next();
        const sid = String(payload.agent.session.id);
        const st = ensure(sid);
        if (!turnStartTimes.has(sid)) {
            turnStartTimes.set(sid, performance.now());
            st.turns = Math.max(st.turns, payload.turn);
        }
        st.steps += 1;
        return next();
    });
    ctx.on('llm/stream', async function* (options, next) {
        if (options.purpose) {
            yield* next();
            return;
        }
        const rawSid = options.sessionId;
        const sid = rawSid !== undefined ? String(rawSid) : 'default';
        const st = ensure(sid);
        const reqProvider = String(options.provider ?? 'unknown');
        const reqModel = String(options.model ?? 'unknown');
        const reqEffort = String(options.reasoningEffort ?? 'default');
        const modelKey = `${reqProvider}/${reqModel}:${reqEffort}`;
        if (!st.modelBreakdown[modelKey]) {
            st.modelBreakdown[modelKey] = { steps: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
        }
        st.modelBreakdown[modelKey].steps += 1;
        const reqStarted = performance.now();
        for await (const chunk of next()) {
            if (st.ttfrMs === null) {
                st.ttfrMs = Number((performance.now() - reqStarted).toFixed(1));
            }
            const usage = chunk?.usage;
            if (usage && typeof usage === 'object') {
                const uncachedIn = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
                const cacheRead = Number(usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? 0);
                const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? 0);
                const promptStepTokens = uncachedIn + cacheRead + cacheWrite;
                const thinkTok = Number(usage.reasoningTokens ?? usage.thinkingTokens ?? 0);
                const outTok = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
                if (promptStepTokens > 0) {
                    if (st.step1PromptTokens === null)
                        st.step1PromptTokens = promptStepTokens;
                    st.contextCurve.push(promptStepTokens);
                    st.inputTokens += promptStepTokens;
                    st.uncachedInputTokens += uncachedIn;
                    st.cachedInputTokens += cacheRead;
                    st.cacheWriteTokens += cacheWrite;
                    st.modelBreakdown[modelKey].inputTokens += promptStepTokens;
                }
                if (thinkTok > 0) {
                    st.thinkingTokens += thinkTok;
                    st.modelBreakdown[modelKey].thinkingTokens += thinkTok;
                }
                if (outTok > 0) {
                    st.outputTokens += outTok;
                    st.modelBreakdown[modelKey].outputTokens += outTok;
                }
            }
            yield chunk;
        }
    });
    ctx.on('tools/result', (exec) => {
        const sid = exec.agent?.session?.id ? String(exec.agent.session.id) : 'default';
        const st = ensure(sid);
        if (exec.parent) {
            st.ptcToolCalls += 1;
        }
        else {
            st.directToolCalls += 1;
        }
        if (exec.name === 'ask_advisor')
            st.advisorCalls += 1;
        syncDerivedMetrics(st);
    });
    ctx.on('agent/turn-stopping', ({ agent }) => {
        if (!agent?.session?.id)
            return;
        const sid = String(agent.session.id);
        const st = ensure(sid);
        const t0 = turnStartTimes.get(sid);
        if (t0 !== undefined) {
            st.wallMs = Number((performance.now() - t0).toFixed(1));
            turnStartTimes.delete(sid);
        }
        syncDerivedMetrics(st);
        flushToDisk();
    });
    ctx.effect(() => () => {
        flushToDisk();
    });
}
//# sourceMappingURL=flight-recorder.js.map