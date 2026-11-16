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
                cachedInputTokens: 0,
                thinkingTokens: 0,
                outputTokens: 0,
                switchyardEscalations: 0,
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
        st.peakRssMb = Math.max(st.peakRssMb, Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)));
        return st;
    };
    const flushToDisk = (targetPath = outFile) => {
        if (!targetPath)
            return null;
        try {
            const abs = resolve(targetPath);
            mkdirSync(dirname(abs), { recursive: true });
            const rows = [...sessions.values()].map((s) => syncDerivedMetrics({ ...s }));
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
                return syncDerivedMetrics({ ...(existing ?? ensure(sessionId)) });
            }
            return [...sessions.values()].map((s) => syncDerivedMetrics({ ...s }));
        },
        flushToDisk,
    });
    ctx.on('agent/disposed', ({ agent }) => {
        const sid = String(agent.session.id);
        turnStartTimes.delete(sid);
        if (sessions.size > 256)
            sessions.delete(sid);
    });
    ctx.on('agent/pre-step', async (payload, next) => {
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
        const rawSid = options.sessionId;
        const sid = rawSid !== undefined ? String(rawSid) : 'default';
        const st = ensure(sid);
        const reqStarted = performance.now();
        for await (const chunk of next()) {
            if (st.ttfrMs === null) {
                st.ttfrMs = Number((performance.now() - reqStarted).toFixed(1));
            }
            const usage = chunk?.usage;
            if (usage && typeof usage === 'object') {
                const inTok = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
                const cacheTok = Number(usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? 0);
                const thinkTok = Number(usage.thinkingTokens ?? usage.reasoningTokens ?? 0);
                const outTok = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
                if (inTok > 0) {
                    if (st.step1PromptTokens === null)
                        st.step1PromptTokens = inTok;
                    st.contextCurve.push(inTok);
                    st.inputTokens += inTok;
                }
                if (cacheTok > 0)
                    st.cachedInputTokens += cacheTok;
                if (thinkTok > 0)
                    st.thinkingTokens += thinkTok;
                if (outTok > 0)
                    st.outputTokens += outTok;
            }
            yield chunk;
        }
    });
    ctx.on('tools/result', (exec) => {
        const sid = exec.agent ? String(exec.agent.session.id) : 'default';
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