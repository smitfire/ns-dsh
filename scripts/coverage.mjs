#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE_DIR = join(ROOT_DIR, '.local', 'coverage');
const V8_DIR = join(COVERAGE_DIR, 'v8');
const THRESHOLD_PCT = Number(process.env.NS_COVERAGE_THRESHOLD || 90);
if (!Number.isFinite(THRESHOLD_PCT) || THRESHOLD_PCT < 0 || THRESHOLD_PCT > 100) {
  throw new Error(`Invalid NS_COVERAGE_THRESHOLD: ${process.env.NS_COVERAGE_THRESHOLD}`);
}
const PLUGINS = ['context', 'codemode', 'cuga', 'board', 'team', 'tui'];

const skipBuild = process.argv.includes('--skip-build');

function runNodeSync(args, opts = {}) {
  return execFileSync(process.execPath, args, {
    cwd: opts.cwd ?? ROOT_DIR,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
}

function collectRuntimeJsFiles() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.js') && !ent.name.endsWith('.test.js')) {
        out.push(realpathSync(full));
      }
    }
  };
  for (const p of PLUGINS) {
    const pluginDist = join(ROOT_DIR, 'plugins', p, 'dist');
    if (!existsSync(pluginDist)) throw new Error(`Missing ${pluginDist}; run without --skip-build first.`);
    walk(pluginDist);
  }
  const rootDist = join(ROOT_DIR, 'dist');
  const cliEntry = join(ROOT_DIR, 'bin', 'ns-dsh.mjs');
  if (!existsSync(rootDist) || !existsSync(cliEntry)) {
    throw new Error('Missing dist/ or bin/ns-dsh.mjs; run build first.');
  }
  walk(rootDist);
  out.push(realpathSync(cliEntry));
  return [...new Set(out)].sort();
}

function buildAllPackages() {
  const tscRoot = join(ROOT_DIR, 'node_modules', '.bin', 'tsc');
  for (const p of PLUGINS) {
    const dir = join(ROOT_DIR, 'plugins', p);
    execFileSync(tscRoot, ['-p', join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'inherit' });
    execFileSync(tscRoot, ['-p', join(dir, 'tsconfig.test.json')], { cwd: dir, stdio: 'inherit' });
  }
  execFileSync(tscRoot, ['-p', join(ROOT_DIR, 'tsconfig.json')], { cwd: ROOT_DIR, stdio: 'inherit' });
  execFileSync(tscRoot, ['-p', join(ROOT_DIR, 'tsconfig.test.json')], { cwd: ROOT_DIR, stdio: 'inherit' });
}

function buildSandboxEnv(baseEnv, sandboxDir) {
  const dirs = {
    HOME: join(sandboxDir, 'home'),
    XDG_CONFIG_HOME: join(sandboxDir, 'xdg-config'),
    XDG_CACHE_HOME: join(sandboxDir, 'xdg-cache'),
    XDG_DATA_HOME: join(sandboxDir, 'xdg-data'),
    XDG_STATE_HOME: join(sandboxDir, 'xdg-state'),
    NS_DSH_HOME: join(sandboxDir, 'dsh-home'),
    DSH_HOME: join(sandboxDir, 'dsh-home'),
    NS_DSH_STATE_DIR: join(sandboxDir, 'ns-dsh-state'),
    FOREWISP_DATA_DIR: join(sandboxDir, '.forewisp'),
    NS_BOARD_DIR: join(sandboxDir, '.board'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const env = { ...baseEnv, ...dirs };
  for (const secretKey of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'OCR_LLM_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'DSH_BIN']) {
    delete env[secretKey];
  }
  return env;
}

function probeMcpServer(pluginName, covEnv, sandboxDir) {
  const serverPath = join(ROOT_DIR, 'plugins', pluginName, 'dist', 'mcp', 'server.js');
  const toolPayloads = {
    context: [
      {
        name: 'forewisp_upsert',
        arguments: {
          kind: 'memory',
          title: 'Cov note',
          summary: 'Timing safe comparison test note',
          body: 'Always use timingSafeEqual for token digests',
        },
      },
      { name: 'forewisp_search', arguments: { query: 'timingSafeEqual' } },
      { name: 'forewisp_expand', arguments: { id: 'missing', allowStale: true } },
      { name: 'forewisp_feedback', arguments: { id: 'missing', helpful: true } },
    ],
    codemode: [
      { name: 'vars_list', arguments: {} },
      { name: 'run_code', arguments: { code: 'const a = await tools.ctx_index("cov.log", "hello\\nworld"); await tools.vars_set("k", 42); return { a, v: await tools.vars_get("k") };' } },
      { name: 'ctx_search', arguments: { query: 'hello' } },
      { name: 'ctx_slice', arguments: { artifactId: 'missing', startLine: 1, endLine: 2 } },
    ],
    cuga: [
      { name: 'cuga_classify_reasoning', arguments: { prompt: 'Rename foo to bar in a.ts' } },
      { name: 'cuga_evaluate_policy', arguments: { toolName: 'bash', arguments: { command: 'echo ok' } } },
      { name: 'cuga_evaluate_intent', arguments: { text: 'List files in src' } },
      { name: 'cuga_crystallize_playbook', arguments: { goal: 'Fix bug', steps: [{ tool: 'read', argsSummary: 'a.ts', ok: true }], verified: true } },
    ],
    board: [
      { name: 'board_view', arguments: {} },
      { name: 'board_propose', arguments: { id: 'mcp-b1', title: 'Cov task', description: 'Verify board MCP', owner: 'coder' } },
      { name: 'board_move', arguments: { cardId: 'mcp-b1', toColumn: 'ready', expectedRevision: 1 } },
      { name: 'board_comment', arguments: { cardId: 'mcp-b1', body: 'MCP verified' } },
    ],
    team: [
      { name: 'switchyard_evaluate', arguments: { toolName: 'read_file', isError: false, argsSummary: 'a.ts' } },
      { name: 'export_switchyard_config', arguments: {} },
      { name: 'review_worktree_gate', arguments: { testCommand: 'node -e "process.exit(0)"', runOcr: false } },
    ],
    tui: [
      { name: 'tui_format_status', arguments: { cwd: sandboxDir, sessionId: 'cov-s1', model: 'gemini-3.8-flash', planMode: true, forewispStrategy: 'jev', forewispOffers: 1 } },
      { name: 'tui_format_diff', arguments: { path: 'src/a.ts', oldText: 'a', newText: 'b' } },
      { name: 'tui_format_diff', arguments: { path: 'src/new.ts', oldText: null, newText: 'line1\nline2', maxLines: 8 } },
      { name: 'tui_format_diff', arguments: { path: 'src/bad.ts', oldText: 123, newText: 'x' } },
      { name: 'tui_parse_command', arguments: { line: '/plan on' } },
    ],
  }[pluginName] ?? [];

  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { jsonrpc: '2.0', id: 4, method: 'unknown/method' },
    { jsonrpc: '2.0', id: 5 },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: toolPayloads[0]?.name ?? 'x', arguments: 'not-an-object' } },
    ...toolPayloads.map((p, idx) => ({ jsonrpc: '2.0', id: 10 + idx, method: 'tools/call', params: p })),
    { jsonrpc: '2.0', id: 98, method: 'tools/call', params: { name: toolPayloads[0]?.name ?? 'missing', arguments: {} } },
    { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } },
  ];
  const stdout = runNodeSync([serverPath], {
    cwd: sandboxDir,
    env: buildSandboxEnv(covEnv, sandboxDir),
    input: `${msgs.map((m) => JSON.stringify(m)).join('\n')}\n[]\n{malformed_json\n`,
    timeout: 20_000,
  });
  const lines = [];
  for (const rawLine of stdout.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      /* skip non-JSON diagnostic output */
    }
  }
  if (!lines.some((r) => r.id === 1 && r.result?.serverInfo)) {
    throw new Error(`MCP initialize failed for ${pluginName}`);
  }
  if (!lines.some((r) => r.id === 2 && Array.isArray(r.result?.tools))) {
    throw new Error(`MCP tools/list failed for ${pluginName}`);
  }
}

function isExecutableLine(trimmed) {
  if (!trimmed) return false;
  if (trimmed.startsWith('#!') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.endsWith('*/')) {
    return false;
  }
  if (trimmed === '{' || trimmed === '}' || trimmed === '};' || trimmed === '],' || trimmed === ');') {
    return false;
  }
  if (trimmed.startsWith('//# sourceMappingURL=')) return false;
  return true;
}

function mergeV8LineCoverage(runtimeFiles) {
  const byFile = new Map(runtimeFiles.map((f) => [f, []]));
  for (const entry of readdirSync(V8_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const payload = JSON.parse(readFileSync(join(V8_DIR, entry), 'utf8'));
    for (const script of payload.result ?? []) {
      if (typeof script.url !== 'string' || !script.url.startsWith('file://')) continue;
      let pathOnDisk;
      try {
        pathOnDisk = realpathSync(fileURLToPath(script.url));
      } catch {
        continue;
      }
      if (!byFile.has(pathOnDisk)) continue;
      const scriptRanges = [];
      for (const fn of script.functions ?? []) {
        if (Array.isArray(fn.ranges)) scriptRanges.push(...fn.ranges);
      }
      if (scriptRanges.length > 0) byFile.get(pathOnDisk).push(scriptRanges);
    }
  }

  let totalLines = 0;
  let coveredLines = 0;
  const fileReports = [];

  for (const filePath of runtimeFiles) {
    const source = readFileSync(filePath, 'utf8');
    const snapshots = byFile.get(filePath) ?? [];
    const lines = source.split('\n');
    let offset = 0;
    let fileTotal = 0;
    let fileCovered = 0;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineStart = offset;
      const lineEnd = offset + line.length;
      offset = lineEnd + 1;

      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
        inBlockComment = true;
        continue;
      }
      if (!isExecutableLine(trimmed)) continue;

      const firstNonWs = lineStart + line.search(/\S/);
      let totalCount = 0;
      for (const scriptRanges of snapshots) {
        let bestSpan = Infinity;
        let bestCount = 0;
        for (const r of scriptRanges) {
          if (r.startOffset <= firstNonWs && r.endOffset > firstNonWs) {
            const span = r.endOffset - r.startOffset;
            if (span < bestSpan || (span === bestSpan && r.count > bestCount)) {
              bestSpan = span;
              bestCount = r.count;
            }
          }
        }
        totalCount += bestCount;
      }
      fileTotal += 1;
      if (totalCount > 0) fileCovered += 1;
    }

    totalLines += fileTotal;
    coveredLines += fileCovered;
    fileReports.push({
      file: relative(ROOT_DIR, filePath),
      covered: fileCovered,
      total: fileTotal,
      pct: fileTotal > 0 ? Number(((fileCovered / fileTotal) * 100).toFixed(2)) : 100,
    });
  }

  const pct = totalLines > 0 ? Number(((coveredLines / totalLines) * 100).toFixed(2)) : 0;
  return {
    pct,
    covered: coveredLines,
    total: totalLines,
    files: fileReports.sort((a, b) => a.pct - b.pct),
  };
}

if (!skipBuild) buildAllPackages();

rmSync(join(COVERAGE_DIR, 'summary.json'), { force: true });
rmSync(V8_DIR, { recursive: true, force: true });
mkdirSync(V8_DIR, { recursive: true });

const covEnv = { ...process.env, NODE_V8_COVERAGE: V8_DIR };
for (const p of PLUGINS) {
  const dir = join(ROOT_DIR, 'plugins', p);
  const testDir = join(dir, 'test');
  if (!existsSync(testDir)) {
    throw new Error(`Missing plugin test directory ${testDir}; run: git submodule update --init --recursive`);
  }
  const testFiles = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => join('test', f));
  runNodeSync(['--test', '--test-timeout=60000', ...testFiles], { cwd: dir, env: covEnv });
}

const rootTestDir = join(ROOT_DIR, 'test');
if (!existsSync(rootTestDir)) throw new Error(`Missing root test directory ${rootTestDir}`);
const rootTests = readdirSync(rootTestDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('test', f));
if (rootTests.length === 0) throw new Error(`No root *.test.ts files found in ${rootTestDir}`);
runNodeSync(['--test', '--test-concurrency=1', '--test-timeout=120000', ...rootTests], { cwd: ROOT_DIR, env: covEnv, timeout: 180_000 });

const mcpSandbox = join(COVERAGE_DIR, 'mcp-sandbox');
rmSync(mcpSandbox, { recursive: true, force: true });
mkdirSync(mcpSandbox, { recursive: true });
try {
  const cliSandboxEnv = buildSandboxEnv(covEnv, mcpSandbox);
  for (const p of PLUGINS) {
    probeMcpServer(p, cliSandboxEnv, mcpSandbox);
  }
  runNodeSync([join(ROOT_DIR, 'plugins', 'context', 'dist', 'mcp', 'server.js'), 'pre-invocation', mcpSandbox], {
    env: cliSandboxEnv,
    input: JSON.stringify({ prompt: 'timingSafeEqual' }),
    timeout: 15_000,
  });
  const initDir = join(mcpSandbox, 'init-out');
  runNodeSync([join(ROOT_DIR, 'bin', 'ns-dsh.mjs'), 'status'], { env: cliSandboxEnv });
  runNodeSync([join(ROOT_DIR, 'bin', 'ns-dsh.mjs'), 'init', '--agy', '--claude', '--cursor', '--switchyard', '--out', initDir], { env: cliSandboxEnv });
  runNodeSync([join(ROOT_DIR, 'bin', 'ns-dsh.mjs'), 'upgrade', '--dry-run'], { env: cliSandboxEnv });
  runNodeSync([join(ROOT_DIR, 'bin', 'ns-dsh.mjs'), '--help'], { env: cliSandboxEnv });
} finally {
  rmSync(mcpSandbox, { recursive: true, force: true });
}

const runtimeFiles = collectRuntimeJsFiles();
const summary = mergeV8LineCoverage(runtimeFiles);
const report = {
  generatedAt: new Date().toISOString(),
  lines: { covered: summary.covered, total: summary.total, pct: summary.pct },
  thresholdPct: THRESHOLD_PCT,
  passed: summary.pct >= THRESHOLD_PCT,
  exclusions: [
    'test/**/*.ts (test suites)',
    'node_modules/** (third-party dependencies)',
    '.local/** (local E2E build artifacts & ledgers)',
    'bench/**, eval/**, scripts/** (evaluation & harness runners)',
    '**/*.d.ts, **/*.js.map (declarations and sourcemaps)',
  ],
  lowestCoveredFiles: summary.files.slice(0, 10),
  files: summary.files,
};
const summaryPath = join(COVERAGE_DIR, 'summary.json');
const tmpSummaryPath = `${summaryPath}.${process.pid}.tmp`;
writeFileSync(tmpSummaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
renameSync(tmpSummaryPath, summaryPath);
console.log(`First-party JavaScript line coverage: ${summary.pct}% (${summary.covered}/${summary.total})`);
if (summary.pct < THRESHOLD_PCT) {
  console.error('Lowest covered files:', JSON.stringify(report.lowestCoveredFiles, null, 2));
  process.exit(1);
}
