import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

function parseSemver(raw: string): ParsedSemver | null {
  const m = raw.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const ap = a.pre.split('.');
  const bp = b.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]) ? Number(ap[i]) : ap[i];
    const bn = /^\d+$/.test(bp[i]) ? Number(bp[i]) : bp[i];
    if (an !== bn) {
      if (typeof an === 'number' && typeof bn === 'number') return an - bn;
      if (typeof an === 'number') return -1;
      if (typeof bn === 'number') return 1;
      return an < bn ? -1 : 1;
    }
  }
  return 0;
}

function caretUpperBound(target: ParsedSemver): ParsedSemver {
  if (target.major > 0) return { major: target.major + 1, minor: 0, patch: 0, pre: '0' };
  if (target.minor > 0) return { major: 0, minor: target.minor + 1, patch: 0, pre: '0' };
  return { major: 0, minor: 0, patch: target.patch + 1, pre: '0' };
}

interface ParsedComparator {
  op: '>=' | '<=' | '>' | '<' | '=' | '^' | '~';
  target: ParsedSemver;
}

function parseRangeClause(clause: string): ParsedComparator[] {
  let normalized = clause.trim();
  if (!normalized) throw new Error('empty semver range clause');
  if (/\s-\s/.test(normalized)) {
    const hm = normalized.match(/^(\S+)\s+-\s+(\S+)$/);
    if (!hm) throw new Error(`unsupported hyphen range: ${clause}`);
    normalized = `>=${hm[1]} <=${hm[2]}`;
  }
  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts.map((token) => {
    const m = token.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
    if (!m) throw new Error(`invalid semver range token: ${token}`);
    const op = (m[1] ?? '=') as ParsedComparator['op'];
    const target = parseSemver(m[2]);
    if (!target) throw new Error(`unsupported semver target in range token: ${token}`);
    return { op, target };
  });
}

function evalParsedClause(actual: ParsedSemver, comps: readonly ParsedComparator[]): boolean {
  for (const { op, target } of comps) {
    const cmp = compareSemver(actual, target);
    if (op === '>=' && cmp < 0) return false;
    else if (op === '<=' && cmp > 0) return false;
    else if (op === '>' && cmp <= 0) return false;
    else if (op === '<' && cmp >= 0) return false;
    else if (op === '=' && cmp !== 0) return false;
    else if (op === '^') {
      const upper = caretUpperBound(target);
      if (cmp < 0 || compareSemver(actual, upper) >= 0) return false;
    } else if (op === '~') {
      const upper: ParsedSemver = { major: target.major, minor: target.minor + 1, patch: 0, pre: '0' };
      if (cmp < 0 || compareSemver(actual, upper) >= 0) return false;
    }
  }
  return true;
}

/**
 * Evaluates semver comparators including `||` unions, `A - B` hyphen ranges,
 * `^`/`~` explicit upper bounds, and prerelease comparisons; throws on invalid range syntax.
 */
export function assertSatisfiesDshPrereleaseRange(version: string, range: string): boolean {
  const actual = parseSemver(version);
  if (!actual) throw new Error(`invalid semver version: ${version}`);
  const rawClauses = range.split('||');
  if (rawClauses.length === 0 || rawClauses.some((c) => c.trim().length === 0)) {
    throw new Error(`unsupported or empty semver range: ${range}`);
  }
  const parsedClauses = rawClauses.map(parseRangeClause);
  return parsedClauses.some((clause) => evalParsedClause(actual, clause));
}

export function satisfiesDshPrereleaseRange(version: string, range: string): boolean {
  try {
    return assertSatisfiesDshPrereleaseRange(version, range);
  } catch {
    return false;
  }
}

export function backupProfileConfig(profileDir: string): string {
  const pkgPath = join(profileDir, 'package.json');
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const backupDir = join(profileDir, '.ns-dsh-backup');
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(pkgPath)) copyFileSync(pkgPath, join(backupDir, 'package.json.bak'));
  if (existsSync(patchPath)) copyFileSync(patchPath, join(backupDir, 'cordis.patch.yml.bak'));
  return backupDir;
}

export function rollbackProfileConfig(profileDir: string): boolean {
  const backupDir = join(profileDir, '.ns-dsh-backup');
  const pkgBak = join(backupDir, 'package.json.bak');
  const patchBak = join(backupDir, 'cordis.patch.yml.bak');
  if (!existsSync(pkgBak)) return false;
  copyFileSync(pkgBak, join(profileDir, 'package.json'));
  if (existsSync(patchBak)) copyFileSync(patchBak, join(profileDir, 'cordis.patch.yml'));
  return true;
}

export const WORKSPACE_PLUGINS = ['context', 'codemode', 'cuga', 'board', 'team', 'tui'] as const;

export function runUpgradeCanary(opts: {
  workspaceRoot: string;
  targetDshVersion?: string;
  dryRun?: boolean;
  runUnitTests?: boolean;
}): UpgradeCanaryResult {
  const root = resolve(opts.workspaceRoot);
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const currentDsh = rootPkg.devDependencies?.['@deepseek-ai/dsh'] ?? '0.2.2-rc.3';
  const targetVersion = opts.targetDshVersion ?? currentDsh;
  const dryRun = opts.dryRun !== false;

  const checks: CanaryPluginCheck[] = [];

  for (const name of WORKSPACE_PLUGINS) {
    const dir = join(root, 'plugins', name);
    const started = performance.now();
    let range = '>=0.2.2-rc.3 <0.3.0-0';
    let compatible = false;
    let typecheckPassed = false;
    let unitTestsPassed: boolean | undefined;
    let error: string | undefined;

    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { engines?: { dsh?: string } };
      range = pkg.engines?.dsh ?? range;
      try {
        compatible = assertSatisfiesDshPrereleaseRange(targetVersion, range);
      } catch (rangeErr) {
        compatible = false;
        error = `unsupported engine range: ${rangeErr instanceof Error ? rangeErr.message : String(rangeErr)}`;
      }

      const testCfg = join(dir, 'tsconfig.test.json');
      const tscLocal = join(dir, 'node_modules', '.bin', 'tsc');
      const tscRoot = join(root, 'node_modules', '.bin', 'tsc');
      let tscBin: string | null = null;
      if (existsSync(tscLocal)) tscBin = tscLocal;
      else if (existsSync(tscRoot)) tscBin = tscRoot;

      if (!existsSync(testCfg)) {
        error = error ? `${error}; missing ${testCfg}` : `missing ${testCfg}`;
      } else if (!tscBin) {
        error = error ? `${error}; missing tsc binary in plugin or root node_modules/.bin` : 'missing tsc binary in plugin or root node_modules/.bin';
      } else {
        const tc = spawnSync(
          tscBin,
          ['-p', testCfg],
          { cwd: dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        typecheckPassed = tc.status === 0;
        if (!typecheckPassed) {
          const tcMsg = (tc.error ? tc.error.message : `${tc.stdout ?? ''}\n${tc.stderr ?? ''}`).trim().slice(0, 500);
          error = error ? `${error}; ${tcMsg}` : tcMsg;
        } else if (opts.runUnitTests) {
          const testDir = join(dir, 'test');
          const testFiles = existsSync(testDir)
            ? readdirSync(testDir)
                .filter((f) => f.endsWith('.test.ts'))
                .sort()
                .map((f) => join('test', f))
            : [];
          if (testFiles.length === 0) {
            unitTestsPassed = false;
            const noTestsMsg = `no test/*.test.ts files found in ${dir}`;
            error = error ? `${error}; ${noTestsMsg}` : noTestsMsg;
          } else {
            // Strip NODE_TEST_CONTEXT so nested `node --test` invocations don't attach to the parent runner.
            const childEnv = { ...process.env };
            delete childEnv.NODE_TEST_CONTEXT;
            const nt = spawnSync(process.execPath, ['--test', ...testFiles], {
              cwd: dir,
              encoding: 'utf8',
              env: childEnv,
              timeout: 60_000,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            unitTestsPassed = nt.status === 0;
            if (!unitTestsPassed) {
              const ntMsg = `${nt.stdout ?? ''}\n${nt.stderr ?? ''}`.trim().slice(0, 500);
              error = error ? `${error}; ${ntMsg}` : ntMsg;
            }
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    checks.push({
      plugin: `@smitfire/${name}`,
      engineRange: range,
      compatible,
      typecheckPassed,
      ...(unitTestsPassed !== undefined ? { unitTestsPassed } : {}),
      durationMs: Number((performance.now() - started).toFixed(1)),
      ...(error ? { error } : {}),
    });
  }

  const ok = checks.every((c) => c.compatible && c.typecheckPassed && (c.unitTestsPassed ?? true));
  const notes = [
    dryRun
      ? `Dry-run canary verified ${checks.length} child plugins against @deepseek-ai/dsh@${targetVersion}`
      : `Live upgrade gate ${ok ? 'passed' : 'failed'} for @deepseek-ai/dsh@${targetVersion}`,
  ];
  return { ok, targetDshVersion: targetVersion, dryRun, checks, notes };
}

export function cleanTempBackup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function writeJsonAtomicReport(path: string, data: unknown): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, abs);
}
