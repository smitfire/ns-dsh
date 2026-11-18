export interface CanaryPluginCheck {
    plugin: string;
    engineRange: string;
    compatible: boolean;
    typecheckPassed: boolean;
    unitTestsPassed?: boolean;
    durationMs: number;
    error?: string;
}
export interface UpgradeCanaryResult {
    ok: boolean;
    targetDshVersion: string;
    dryRun: boolean;
    checks: CanaryPluginCheck[];
    notes: string[];
}
/**
 * Evaluates semver comparators including `||` unions, `A - B` hyphen ranges,
 * `^`/`~` explicit upper bounds, and prerelease comparisons; throws on invalid range syntax.
 */
export declare function assertSatisfiesDshPrereleaseRange(version: string, range: string): boolean;
export declare function satisfiesDshPrereleaseRange(version: string, range: string): boolean;
export declare function backupProfileConfig(profileDir: string): string;
export declare function rollbackProfileConfig(profileDir: string): boolean;
export declare const WORKSPACE_PLUGINS: readonly ["context", "codemode", "cuga", "board", "team", "tui"];
export declare function runUpgradeCanary(opts: {
    workspaceRoot: string;
    targetDshVersion?: string;
    dryRun?: boolean;
    runUnitTests?: boolean;
}): UpgradeCanaryResult;
export declare function cleanTempBackup(dir: string): void;
export declare function writeJsonAtomicReport(path: string, data: unknown): void;
//# sourceMappingURL=canary.d.ts.map