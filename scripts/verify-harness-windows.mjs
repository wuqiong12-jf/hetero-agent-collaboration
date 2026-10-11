#!/usr/bin/env node
// Agentless ACL carrier checks. Every mutable fixture belongs to one mkdtemp root.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

export const FIXTURE_PREFIX = 'relay-harness-acl-';
export const DEFAULT_RUNNER = String.raw`C:\snapshot\node\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js`;
const PROBE_PREFIX = 'RELAY_ACL_PROBE ';
const OUTPUT_LIMIT = 64 * 1024;
const CONTENT = Object.freeze({ baseline: 'relay-acl-baseline-v1', workspace: 'relay-acl-workspace-v1', temp: 'relay-acl-temp-v1', outside: 'relay-acl-outside-v1' });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fullyQualified = (value) => typeof value === 'string' && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+\\/.test(value));

export function parseCli(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--bin', '--node', '--runner', '--timeout-ms'].includes(flag)) throw new Error('Unknown option; use --help.');
    if (values.has(flag)) throw new Error('Options may only be supplied once.');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('Every option requires a value.');
    values.set(flag, value);
  }
  if (values.has('--bin') === values.has('--node')) throw new Error('Supply exactly one of --bin or --node.');
  const executable = values.get('--bin') ?? values.get('--node');
  if (!fullyQualified(executable) || path.win32.extname(executable).toLowerCase() !== '.exe' || executable.includes('\0')) {
    throw new Error('The executable must be an absolute Windows .exe path.');
  }
  if (values.has('--node') && !values.has('--runner')) throw new Error('--node requires an explicit physical --runner file.');
  const runner = values.get('--runner');
  if (runner !== undefined && (!fullyQualified(runner) || runner.includes('\0'))) throw new Error('--runner must be an absolute Windows path.');
  const timeoutText = values.get('--timeout-ms') ?? '30000';
  const timeoutMs = Number(timeoutText);
  if (!/^\d+$/.test(timeoutText) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('--timeout-ms must be an integer from 1000 through 120000.');
  }
  return { carrier: values.has('--bin') ? 'packaged-exe' : 'node-runner', executable, runner, timeoutMs };
}

export async function discoverRunnerFromStream(stream) {
  const key = '"entrypoint"';
  const decoder = new StringDecoder('utf8');
  const candidates = new Set();
  let pending = '';
  const scan = (final = false) => {
    while (true) {
      const start = pending.indexOf(key);
      if (start === -1) { pending = pending.slice(-(key.length - 1)); return; }
      pending = pending.slice(start);
      let index = key.length;
      while (pending[index] === ' ' || pending[index] === '\t') index += 1;
      if (index === pending.length) { if (pending.length > 32768) throw new Error('SEA entrypoint field is too long.'); return; }
      if (pending[index] !== ':') { pending = pending.slice(key.length); continue; }
      index += 1;
      while (pending[index] === ' ' || pending[index] === '\t') index += 1;
      if (index === pending.length) { if (final || pending.length > 32768) throw new Error('Incomplete SEA entrypoint field.'); return; }
      if (pending[index] !== '"') { pending = pending.slice(index + 1); continue; }
      const valueStart = index;
      let escaped = false; let valueEnd = -1;
      for (index += 1; index < pending.length; index += 1) {
        const char = pending[index];
        if (char === '\r' || char === '\n' || index - valueStart > 32768) throw new Error('Invalid SEA entrypoint field.');
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { valueEnd = index; break; }
      }
      if (valueEnd === -1) { if (final || pending.length > 32768) throw new Error('Incomplete SEA entrypoint field.'); return; }
      let entrypoint;
      try { entrypoint = JSON.parse(pending.slice(valueStart, valueEnd + 1)); }
      catch { throw new Error('Invalid SEA entrypoint JSON.'); }
      if (entrypoint.startsWith('/snapshot/')) {
        if (path.posix.normalize(entrypoint) !== entrypoint || /[\\\u0000-\u001f<>:"|?*]/.test(entrypoint)) throw new Error('Invalid SEA snapshot entrypoint.');
        if (entrypoint.endsWith('/runtime-bootstrap.mjs')) {
          candidates.add(entrypoint);
          if (candidates.size > 1) throw new Error('Ambiguous SEA snapshot entrypoints.');
        }
      }
      pending = pending.slice(valueEnd + 1);
    }
  };
  for await (const chunk of stream) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    scan();
  }
  pending += decoder.end();
  scan(true);
  if (candidates.size !== 1) throw new Error('SEA snapshot entrypoint is missing.');
  const [entrypoint] = candidates;
  return `C:${path.posix.dirname(entrypoint)}/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js`.replaceAll('/', '\\');
}

export async function resolveRunner(options, { openExecutable = createReadStream } = {}) {
  if (options.runner !== undefined) return options.runner;
  if (options.carrier !== 'packaged-exe') throw new Error('A physical node runner is required.');
  return discoverRunnerFromStream(openExecutable(options.executable, { highWaterMark: 64 * 1024 }));
}

export function assertOwnedFixtureRoot(root, tempDirectory = os.tmpdir(), pathApi = path) {
  const windowsPaths = pathApi === path.win32 || process.platform === 'win32';
  if (typeof root !== 'string' || !pathApi.isAbsolute(root) || (windowsPaths && !fullyQualified(root))) throw new Error('Unsafe fixture root.');
  const resolved = pathApi.resolve(root);
  const parent = pathApi.resolve(tempDirectory);
  const equal = (a, b) => windowsPaths ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!equal(pathApi.dirname(resolved), parent) || !/^relay-harness-acl-[a-z0-9_-]{6,}$/i.test(pathApi.basename(resolved))) {
    throw new Error('Unsafe fixture root.');
  }
  return resolved;
}

export async function removeOwnedFixture(root, { tempDirectory = os.tmpdir(), activeProcesses = 0 } = {}) {
  const resolved = assertOwnedFixtureRoot(root, tempDirectory);
  if (activeProcesses !== 0) throw new Error('Cleanup refused while a child may still be running.');
  let info;
  try { info = await fs.lstat(resolved); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Cleanup refused for a replaced fixture root.');
  // realpath traverses ancestors that Windows AppContainer temp ACLs can deny.
  // The exact mkdtemp parent/prefix and a non-reparse root are checked instead.
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}

export async function createFixture(tempDirectory = os.tmpdir()) {
  const root = await fs.mkdtemp(path.join(tempDirectory, FIXTURE_PREFIX));
  assertOwnedFixtureRoot(root, tempDirectory);
  const fixture = { root, workspace: path.join(root, 'workspace'), temp: path.join(root, 'temp'), outside: path.join(root, 'outside') };
  try {
    for (const directory of [fixture.workspace, fixture.temp, fixture.outside]) await fs.mkdir(directory);
    fixture.baseline = path.join(fixture.outside, 'baseline.txt');
    await fs.writeFile(fixture.baseline, CONTENT.baseline, 'utf8');
  } catch (error) {
    await removeOwnedFixture(root, { tempDirectory });
    throw error;
  }
  return fixture;
}

export function makeInvocation(options, runnerArgs) {
  // No packaged bootstrap in the node comparison: node loads this physical file directly.
  return { executable: options.executable, args: [options.runner, ...runnerArgs] };
}

export function buildChildEnvironment(source, fixture) {
  const allowed = ['SystemRoot', 'WINDIR', 'windir', 'ComSpec', 'COMSPEC', 'PATH', 'Path', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA'];
  const env = {};
  for (const key of allowed) if (typeof source[key] === 'string') env[key] = source[key];
  return { ...env, TEMP: fixture.temp, TMP: fixture.temp };
}

const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
export function buildProbeScript(fixture, mode) {
  const writable = mode === 'workspace-write';
  const stem = writable ? 'workspace-write' : 'read-only';
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$workspace = ${psLiteral(fixture.workspace)}
$tempRoot = ${psLiteral(fixture.temp)}
$outside = ${psLiteral(fixture.outside)}
$baseline = ${psLiteral(fixture.baseline)}
function Try-Write([string]$target, [string]$text) {
  $written = $false; $denied = $false
  try { Set-Content -LiteralPath $target -Value $text -Encoding Ascii -NoNewline -ErrorAction Stop; $written = $true }
  catch {
    $cause = $_.Exception
    while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    $denied = ($cause -is [UnauthorizedAccessException]) -or ($cause -is [System.Security.SecurityException]) -or ($cause.HResult -eq -2147024891)
  }
  $exists = Test-Path -LiteralPath $target -PathType Leaf
  $contentMatches = $false; $hash = $null
  if ($written -and $exists) {
    $observed = Get-Content -LiteralPath $target -Raw -Encoding Ascii -ErrorAction Stop
    $contentMatches = $observed -ceq $text
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  }
  return [ordered]@{ written = $written; denied = $denied; exists = $exists; contentMatches = $contentMatches; sha256 = $hash }
}
$baselineMatches = $false
try { $baselineMatches = (Get-Content -LiteralPath $baseline -Raw -Encoding Ascii -ErrorAction Stop) -ceq ${psLiteral(CONTENT.baseline)} } catch { }
$tempPath = $env:TEMP
$tempScoped = ($tempPath -ieq $tempRoot) -or $tempPath.StartsWith($tempRoot + '\\', [StringComparison]::OrdinalIgnoreCase)
$result = [ordered]@{
  version = 1; mode = ${psLiteral(mode)}; baselineMatches = $baselineMatches; tempScoped = $tempScoped
  workspace = (Try-Write (Join-Path -Path $workspace -ChildPath '${stem}.txt') ${psLiteral(CONTENT.workspace)})
  temp = (Try-Write (Join-Path -Path $tempPath -ChildPath '${stem}.txt') ${psLiteral(CONTENT.temp)})
  outside = (Try-Write (Join-Path -Path $outside -ChildPath '${stem}.txt') ${psLiteral(CONTENT.outside)})
}
$json = $result | ConvertTo-Json -Compress -Depth 5
${writable ? "Set-Content -LiteralPath (Join-Path -Path $workspace -ChildPath 'write-proof.json') -Value $json -Encoding Ascii -NoNewline -ErrorAction Stop" : ''}
Write-Output ('${PROBE_PREFIX}' + $json)
if (-not $baselineMatches -or -not $tempScoped) { exit 31 }
${writable ? 'if (-not $result.workspace.written -or -not $result.temp.written -or -not $result.outside.denied) { exit 32 }' : 'if (-not $result.workspace.denied -or -not $result.temp.denied -or -not $result.outside.denied) { exit 33 }'}
exit 0
`;
}

export function parseProbe(stdout, mode) {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith(PROBE_PREFIX)) return null;
  let value;
  try { value = JSON.parse(lines[0].slice(PROBE_PREFIX.length)); } catch { return null; }
  if (value?.version !== 1 || value.mode !== mode || typeof value.baselineMatches !== 'boolean' || typeof value.tempScoped !== 'boolean') return null;
  for (const name of ['workspace', 'temp', 'outside']) {
    const record = value[name];
    if (!record || ['written', 'denied', 'exists', 'contentMatches'].some((key) => typeof record[key] !== 'boolean')) return null;
    if (record.sha256 !== null && (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256))) return null;
  }
  // Whitelist fields; arbitrary data from a failing executable never reaches the report.
  return { version: 1, mode, baselineMatches: value.baselineMatches, tempScoped: value.tempScoped, ...Object.fromEntries(['workspace', 'temp', 'outside'].map((name) => [name, Object.fromEntries(['written', 'denied', 'exists', 'contentMatches', 'sha256'].map((key) => [key, value[name][key]]))])) };
}

async function nativeExecutables() {
  const systemRoot = process.env.SystemRoot;
  if (!fullyQualified(systemRoot)) throw new Error('Windows system tools are unavailable.');
  const result = { cmd: path.join(systemRoot, 'System32', 'cmd.exe'), powershell: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), taskkill: path.join(systemRoot, 'System32', 'taskkill.exe') };
  for (const executable of Object.values(result)) if (!(await fs.stat(executable)).isFile()) throw new Error('Windows system tools are unavailable.');
  return result;
}

async function prepare(options) {
  if (process.platform !== 'win32') throw new Error('This verification requires Windows.');
  if (!(await fs.stat(options.executable)).isFile()) throw new Error('The executable is not a file.');
  if (options.carrier === 'node-runner' && !(await fs.stat(options.runner)).isFile()) throw new Error('The physical runner is not a file.');
  const runner = await resolveRunner(options);
  return { ...await nativeExecutables(), runner };
}

async function terminateWindowsTree(pid, taskkill, timeoutMs = 10000, spawnProcess = spawn) {
  return new Promise((resolve) => {
    let killer;
    try { killer = spawnProcess(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { resolve({ ok: false, finished: true }); return; }
    let done = false; let timedOut = false; let failed = false; let graceTimer;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(graceTimer); resolve(value); } };
    const timer = setTimeout(() => {
      timedOut = true; killer.kill();
      graceTimer = setTimeout(() => { killer.unref(); finish({ ok: false, finished: false }); }, 3000);
    }, timeoutMs);
    killer.once('error', () => { failed = true; });
    killer.once('close', (code) => finish({ ok: code === 0 && !failed && !timedOut, finished: true }));
  });
}

export async function runCommand({ executable, args, cwd, env, timeoutMs, taskkill, signal, spawnProcess = spawn }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(executable, args, { shell: false, windowsHide: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: null, stdout: '', stderr: '', finished: true, spawnFailed: true }); return; }
    let stdout = ''; let stderr = ''; let outputBytes = 0;
    let stopping = false; let closed = false; let code = null; let exitSignal = null; let settled = false;
    let timedOut = false; let outputOverflow = false; let aborted = false; let treeKillSucceeded = null; let treeKillFinished = null; let spawnFailed = false;
    let killPromise = null; let graceTimer;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(graceTimer); signal?.removeEventListener('abort', onAbort);
      const finished = closed && (killPromise === null || treeKillFinished === true);
      if (!finished) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
      resolve({ code, signal: exitSignal, stdout, stderr, finished, timedOut, outputOverflow, aborted, treeKillSucceeded, spawnFailed });
    };
    const stop = () => {
      if (stopping || closed) return;
      stopping = true;
      // taskkill owns tree termination, then close confirms the runner and inherited pipes ended.
      killPromise = terminateWindowsTree(child.pid, taskkill, 10000, spawnProcess).then((result) => { treeKillSucceeded = result.ok; treeKillFinished = result.finished; if (closed) finish(); });
      graceTimer = setTimeout(finish, 15000);
    };
    const capture = (which, buffer) => {
      outputBytes += buffer.length;
      if (which === 'stdout') stdout += buffer.toString('utf8').slice(0, Math.max(0, OUTPUT_LIMIT - stdout.length));
      else stderr += buffer.toString('utf8').slice(0, Math.max(0, OUTPUT_LIMIT - stderr.length));
      if (outputBytes > OUTPUT_LIMIT) { outputOverflow = true; stop(); }
    };
    child.stdout.on('data', (buffer) => capture('stdout', buffer));
    child.stderr.on('data', (buffer) => capture('stderr', buffer));
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (exitCode, signalName) => {
      closed = true; code = exitCode; exitSignal = signalName;
      if (killPromise) killPromise.then(finish); else finish();
    });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function safeRunRecord(name, result) {
  return { name, exitCode: Number.isInteger(result.code) ? result.code : null, finished: result.finished === true, timedOut: result.timedOut === true, outputOverflow: result.outputOverflow === true, aborted: result.aborted === true, spawnFailed: result.spawnFailed === true, treeKillSucceeded: typeof result.treeKillSucceeded === 'boolean' ? result.treeKillSucceeded : null, stdout: { bytes: Buffer.byteLength(result.stdout ?? ''), sha256: sha256(result.stdout ?? '') }, stderr: { bytes: Buffer.byteLength(result.stderr ?? ''), sha256: sha256(result.stderr ?? ''), runnerFailureSignature: /windows-acl-run:/.test(result.stderr ?? ''), cleanupFailureSignature: /windows-acl-run:\s*cleanup:/.test(result.stderr ?? ''), moduleLoadFailure: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module/.test(result.stderr ?? ''), nativeLoadFailure: /koffi|dlopen|LoadLibrary|native addon/i.test(result.stderr ?? '') } };
}

const safeErrorCode = (error) => ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EBUSY', 'EIO', 'ENOTDIR', 'EMFILE', 'ENFILE'].includes(error?.code) ? error.code : null;

async function observeFile(file, expectedContent) {
  try {
    const bytes = await fs.readFile(file);
    return { exists: true, contentMatches: bytes.equals(Buffer.from(expectedContent)), sha256: sha256(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, contentMatches: false, sha256: null };
    return { exists: null, contentMatches: false, sha256: null };
  }
}

export async function verifyHarness(options, { invoke = runCommand, prepareExecutables = prepare, tempDirectory = os.tmpdir(), signal } = {}) {
  const report = { version: 1, carrier: options.carrier, ok: false, checks: [], runs: [], artifacts: {}, cleanup: { attempted: false, ok: false } };
  const check = (name, ok) => report.checks.push({ name, ok: ok === true });
  let fixture; let activeProcesses = 0; let failureStage = 'preflight';
  try {
    const tools = await prepareExecutables(options);
    const effectiveOptions = { ...options, runner: tools.runner ?? options.runner };
    if (!fullyQualified(effectiveOptions.runner)) throw new Error('The exact runner path could not be resolved.');
    failureStage = 'fixture-setup';
    fixture = await createFixture(tempDirectory);
    check('owned-fixture-created', true);
    const env = buildChildEnvironment(process.env, fixture);
    const execute = async (name, args) => {
      failureStage = name;
      activeProcesses += 1;
      const result = await invoke({ ...makeInvocation(effectiveOptions, args), cwd: fixture.workspace, env, timeoutMs: options.timeoutMs, taskkill: tools.taskkill, signal, stage: name, fixture });
      if (result.finished === true) activeProcesses -= 1;
      report.runs.push(safeRunRecord(name, result));
      check(`${name}:process-completed`, result.finished === true && !result.timedOut && !result.outputOverflow && !result.aborted && !result.spawnFailed);
      if (result.finished !== true || signal?.aborted) throw new Error('A child did not complete safely.');
      return result;
    };
    const bare = await execute('bare-runner', []);
    const bareValid = bare.code === 127 && /^windows-acl-run:\s*missing --workspace\s*$/m.test(bare.stderr) && bare.stdout.trim() === '';
    check('bare-runner:failure-contract', bareValid);
    if (!bareValid) throw new Error('The carrier did not reach the requested runner.');
    const prefix = (mode) => ['--workspace', fixture.workspace, '--temp', fixture.temp, '--mode', mode, '--'];
    const mirror = await execute('read-only-exit-mirror', [...prefix('read-only'), tools.cmd, '/d', '/s', '/c', 'echo relay-acl-exit17 & exit /b 17']);
    check('read-only-exit-mirror:exit-and-output', mirror.code === 17 && mirror.stdout.trim() === 'relay-acl-exit17' && mirror.stderr.trim() === '');
    for (const mode of ['workspace-write', 'read-only']) {
      const script = buildProbeScript(fixture, mode);
      const run = await execute(mode, [...prefix(mode), tools.powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
      const probe = parseProbe(run.stdout, mode);
      check(`${mode}:exit-and-probe`, run.code === 0 && run.stderr.trim() === '' && probe !== null);
      check(`${mode}:outside-baseline-readable`, probe?.baselineMatches === true);
      check(`${mode}:temp-within-owned-fixture`, probe?.tempScoped === true);
      const writable = mode === 'workspace-write';
      for (const name of ['workspace', 'temp', 'outside']) {
        const shouldWrite = writable && name !== 'outside';
        const value = probe?.[name];
        check(`${mode}:${name}-${shouldWrite ? 'write-succeeds' : 'access-denied'}`, shouldWrite
          ? value?.written === true && value.denied === false && value.exists === true && value.contentMatches === true && value.sha256 === sha256(CONTENT[name])
          : value?.written === false && value.denied === true && value.exists === false && value.contentMatches === false && value.sha256 === null);
      }
      const observations = {};
      for (const name of ['workspace', 'outside']) {
        observations[name] = await observeFile(path.join(fixture[name], `${mode}.txt`), CONTENT[name]);
        check(`${mode}:${name}-host-file-state`, writable && name === 'workspace'
          ? observations[name].exists === true && observations[name].contentMatches
          : observations[name].exists === false);
      }
      // Standalone runners may remove their private TEMP child before returning.
      // TEMP's real write/read/hash is also persisted in a workspace file and compared.
      if (writable) {
        let proof = null;
        try { proof = parseProbe(PROBE_PREFIX + await fs.readFile(path.join(fixture.workspace, 'write-proof.json'), 'utf8'), mode); } catch { }
        check('workspace-write:stdout-matches-persisted-proof', probe !== null && proof !== null && JSON.stringify(probe) === JSON.stringify(proof));
        observations.proofExistsAndMatches = proof !== null && probe !== null && JSON.stringify(probe) === JSON.stringify(proof);
      } else {
        observations.temp = await observeFile(path.join(fixture.temp, 'read-only.txt'), CONTENT.temp);
        check('read-only:temp-host-file-state', observations.temp.exists === false);
        const standing = await observeFile(path.join(fixture.workspace, 'workspace-write.txt'), CONTENT.workspace);
        check('read-only:prior-workspace-file-preserved', standing.exists === true && standing.contentMatches);
      }
      report.artifacts[mode] = { probe, hostFiles: observations };
    }
    report.artifacts.baseline = { content: CONTENT.baseline, ...await observeFile(fixture.baseline, CONTENT.baseline) };
    check('outside-baseline-preserved', report.artifacts.baseline.exists === true && report.artifacts.baseline.contentMatches);
  } catch (error) {
    // Neither argv nor native exception text is reported: both may contain user paths.
    report.failure = { stage: failureStage, code: safeErrorCode(error) };
    check('verification-completed-without-internal-error', false);
  } finally {
    if (fixture) {
      report.cleanup.attempted = true;
      try { await removeOwnedFixture(fixture.root, { tempDirectory, activeProcesses }); report.cleanup.ok = true; }
      catch (error) { report.cleanup.ok = false; report.cleanup.code = safeErrorCode(error); }
    }
    check('owned-fixture-cleanup', report.cleanup.ok);
  }
  report.ok = report.checks.length > 0 && report.checks.every((entry) => entry.ok);
  return report;
}

const USAGE = `Usage:
  node scripts/verify-harness-windows.mjs --bin <absolute.exe> [--runner <exact virtual runner path>]
  node scripts/verify-harness-windows.mjs --node <absolute node.exe> --runner <absolute physical runner.js>
  Optional: --timeout-ms <1000..120000> (default: 30000)
The packaged runner is discovered from the EXE's unique SEA snapshot entrypoint.
Only disposable fixtures are written. No model, profile, or production task is loaded.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let options;
  try { options = parseCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
  if (options?.help) process.stdout.write(USAGE);
  else if (options) {
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const report = await verifyHarness(options, { signal: abort.signal });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}
