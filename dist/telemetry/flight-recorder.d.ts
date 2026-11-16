import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "ns-flight-recorder";
export interface PluginConfig {
    outputPath?: string;
}
export declare const Config: z<PluginConfig>;
export interface SessionTelemetry {
    sessionId: string;
    bootMs: number;
    ttfrMs: number | null;
    wallMs: number;
    turns: number;
    steps: number;
    directToolCalls: number;
    ptcToolCalls: number;
    step1PromptTokens: number | null;
    contextCurve: number[];
    rawToolBytes: number;
    admittedBytes: number;
    ftsBytesSaved: number;
    inputTokens: number;
    uncachedInputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    thinkingTokens: number;
    outputTokens: number;
    switchyardEscalations: number;
    advisorCalls: number;
    peakRssMb: number;
}
export interface FlightRecorderService {
    readonly bootStartedAt: number;
    readonly bootMs: number;
    snapshot(sessionId?: string): SessionTelemetry | SessionTelemetry[];
    flushToDisk(targetPath?: string): string | null;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsFlightRecorder?: FlightRecorderService;
    }
}
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
//# sourceMappingURL=flight-recorder.d.ts.map