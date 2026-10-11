import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DEFAULT_RUNNER, assertOwnedFixtureRoot, buildChildEnvironment, buildProbeScript, createFixture, discoverRunnerFromStream, makeInvocation, parseCli, parseProbe, removeOwnedFixture, resolveRunner, runCommand, verifyHarness } from './verify-harness-windows.mjs';

const OPTIONS = parseCli(['--bin', String.raw`C:\fixture tools\carrier.exe`, '--runner', DEFAULT_RUNNER]);
const TOOLS = { cmd: String.raw`C:\Windows\System32\cmd.exe`, powershell: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, taskkill: String.raw`C:\Windows\System32\taskkill.exe` };
const CONTENT = { workspace: 'relay-acl-workspace-v1', temp: 'relay-acl-temp-v1' };
const hash = (text) => createHash('sha256').update(text).digest('hex');
const wire = (probe) => `RELAY_ACL_PROBE ${JSON.stringify(probe)}\r\n`;
const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr, finished: true });

function successfulProbe(mode) {
  const denied = { written: false, denied: true, exists: false, contentMatches: false, sha256: null };
  const allowed = (name) => ({ written: true, denied: false, exists: true, contentMatches: true, sha256: hash(CONTENT[name]) });
  return { version: 1, mode, baselineMatches: true, tempScoped: true, workspace: mode === 'workspace-write' ? allowed('workspace') : { ...denied }, temp: mode === 'workspace-write' ? allowed('temp') : { ...denied }, outside: { ...denied } };
}

function fakeCarrier({ change = () => {}, omitWorkspaceFile = false, appendStderr = '' } = {}) {
  const calls = [];
  return {
    calls,
    async invoke(call) {
      calls.push(call);
      assert.equal(call.args[0], OPTIONS.runner);
      assert.equal(call.cwd, call.fixture.workspace);
      assert.equal(call.env.TEMP, call.fixture.temp);
      assert.equal(call.env.TMP, call.fixture.temp);
      if (call.stage === 'bare-runner') return result(127, '', 'windows-acl-run: missing --workspace\n');
      assert.deepEqual(call.args.slice(1, 8), ['--workspace', call.fixture.workspace, '--temp', call.fixture.temp, '--mode', call.stage === 'read-only-exit-mirror' ? 'read-only' : call.stage, '--']);
      if (call.stage === 'read-only-exit-mirror') return result(17, 'relay-acl-exit17\r\n');
      const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
      assert.equal(script, buildProbeScript(call.fixture, call.stage));
      assert.ok(script.includes("$ProgressPreference = 'SilentlyContinue'"));
      assert.ok(script.includes('Set-Content -LiteralPath $target -Value $text -Encoding Ascii -NoNewline -ErrorAction Stop'));
      assert.ok(script.includes('Get-Content -LiteralPath $baseline -Raw -Encoding Ascii -ErrorAction Stop'));
      assert.ok(script.includes('Get-FileHash -LiteralPath $target -Algorithm SHA256'));
      assert.equal(/\[(?:IO\.|Console|System\.Text|System\.Security\.Cryptography)/.test(script), false);
      assert.ok(call.args.includes('-NoProfile'));
      assert.ok(call.args.includes('-NonInteractive'));
      const probe = successfulProbe(call.stage);
      change(probe, call);
      if (call.stage === 'workspace-write') {
        if (!omitWorkspaceFile) await fs.writeFile(path.join(call.fixture.workspace, 'workspace-write.txt'), CONTENT.workspace);
        await fs.writeFile(path.join(call.fixture.workspace, 'write-proof.json'), JSON.stringify(probe));
      }
      return result(0, wire(probe), appendStderr);
    },
  };
}

test('CLI accepts exact runner strings and rejects ambiguous or relative invocations', () => {
  assert.equal(OPTIONS.runner, DEFAULT_RUNNER);
  assert.equal(parseCli(['--bin', OPTIONS.executable]).runner, undefined);
  const custom = String.raw`C:\snapshot\different build\runner.js`;
  assert.equal(parseCli(['--bin', OPTIONS.executable, '--runner', custom]).runner, custom);
  const node = parseCli(['--node', String.raw`C:\node\node.exe`, '--runner', String.raw`C:\physical\runner.js`, '--timeout-ms', '1000']);
  assert.equal(node.carrier, 'node-runner');
  assert.deepEqual(makeInvocation(node, ['--mode', 'read-only']), { executable: node.executable, args: [node.runner, '--mode', 'read-only'] });
  for (const args of [[], ['--bin', 'relative.exe'], ['--bin', String.raw`C:relative.exe`], ['--bin', String.raw`\rooted.exe`], ['--bin', String.raw`C:\carrier.cmd`], ['--node', String.raw`C:\node.exe`], ['--bin', OPTIONS.executable, '--node', OPTIONS.executable], ['--bin', OPTIONS.executable, '--runner', 'runner.js'], ['--bin', OPTIONS.executable, '--timeout-ms', '0'], ['--bin', OPTIONS.executable, '--timeout-ms', '1e3'], ['--bin', OPTIONS.executable, '--timeout-ms', '120001'], ['--bin', OPTIONS.executable, '--bin', OPTIONS.executable], ['--bin'], ['--profile', 'anything']]) {
    assert.throws(() => parseCli(args));
  }
  assert.deepEqual(parseCli(['--help']), { help: true });
});

test('SEA runner discovery handles byte boundaries and a parent tree of arbitrary name', async () => {
  const entrypoint = '/snapshot/arbitrary-parent/python/sdk-runtime/src/deepseek_harness_runtime/runtime/node/runtime-bootstrap.mjs';
  const binary = Buffer.from(`binary\0prefix {"entrypoint": ${JSON.stringify(entrypoint)}} binary suffix`);
  const chunks = Array.from(binary, (byte) => Buffer.from([byte]));
  assert.equal(await discoverRunnerFromStream(Readable.from(chunks)), String.raw`C:\snapshot\arbitrary-parent\python\sdk-runtime\src\deepseek_harness_runtime\runtime\node\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js`);
});

test('SEA discovery permits repeated values and ignores unrelated entrypoint fields', async () => {
  const good = '"entrypoint": "/snapshot/parent/runtime-bootstrap.mjs"';
  const expected = String.raw`C:\snapshot\parent\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js`;
  assert.equal(await discoverRunnerFromStream(Readable.from([Buffer.from(good + good)])), expected);
  assert.equal(await discoverRunnerFromStream(Readable.from([Buffer.from('"entrypoint": null "entrypoint": "index.js" "entrypoint": "/snapshot/parent/other.mjs" ' + good)])), expected);
});

test('SEA discovery rejects multiple candidates, missing, malformed and unsafe snapshot values', async () => {
  const good = '"entrypoint": "/snapshot/parent/runtime-bootstrap.mjs"';
  for (const content of [good + '"entrypoint": "/snapshot/other/runtime-bootstrap.mjs"', 'no entrypoint', '"entrypoint": "C:/physical/runtime-bootstrap.mjs"', '"entrypoint": "/snapshot/parent/other.mjs"', '"entrypoint": "/snapshot/parent/../runtime-bootstrap.mjs"', '"entrypoint": "/snapshot/parent/C:/runtime-bootstrap.mjs"', '"entrypoint": "/snapshot/parent/\\\\runtime-bootstrap.mjs"', '"entrypoint": "/snapshot/parent/\\u0000runtime-bootstrap.mjs"', '"entrypoint": null', '"entrypoint": "/snapshot/unfinished', '"entrypoint": "/snapshot/parent/\nruntime-bootstrap.mjs"', '"entrypoint": "/snapshot/parent/\\qruntime-bootstrap.mjs"']) {
    await assert.rejects(discoverRunnerFromStream(Readable.from([Buffer.from(content)])));
  }
});

test('explicit runner bypasses EXE scanning and node comparisons never guess', async () => {
  const openExecutable = () => assert.fail('Explicit runner must not scan the executable.');
  assert.equal(await resolveRunner(OPTIONS, { openExecutable }), OPTIONS.runner);
  const node = parseCli(['--node', String.raw`C:\node\node.exe`, '--runner', String.raw`C:\physical\runner.js`]);
  assert.equal(await resolveRunner(node, { openExecutable }), node.runner);
  await assert.rejects(resolveRunner({ ...node, runner: undefined }, { openExecutable }));
});

test('cleanup guard requires an absolute prefixed root directly below the designated temp directory', () => {
  const root = String.raw`C:\Temp\relay-harness-acl-a1B2c3`;
  assert.equal(assertOwnedFixtureRoot(root, String.raw`C:\Temp`, path.win32), root);
  for (const unsafe of [String.raw`C:\Temp`, String.raw`\Temp\relay-harness-acl-a1B2c3`, String.raw`C:\Elsewhere\relay-harness-acl-a1B2c3`, String.raw`C:\Temp\unrelated-a1B2c3`, String.raw`C:\Temp\relay-harness-acl-`, String.raw`C:\Temp\relay-harness-acl-a1B2c3\workspace`, String.raw`C:\Temp\relay-harness-acl-a1B2c3\..`, 'relative']) {
    assert.throws(() => assertOwnedFixtureRoot(unsafe, String.raw`C:\Temp`, path.win32));
  }
});

test('child environment excludes credentials and harness selectors while fixing private temp roots', () => {
  const fixture = { temp: String.raw`C:\Temp\relay-harness-acl-a1B2c3\temp` };
  const env = buildChildEnvironment({ SystemRoot: String.raw`C:\Windows`, Path: String.raw`C:\Windows\System32`, APPDATA: 'allowed-appdata', TEMP: 'unowned-temp', TMP: 'unowned-temp', OPENAI_API_KEY: 'secret-one', DEEPSEEK_API_KEY: 'secret-two', DSH_SANDBOX_PROVIDER: 'off', NODE_OPTIONS: '--require unwanted.js' }, fixture);
  assert.deepEqual(env, { SystemRoot: String.raw`C:\Windows`, Path: String.raw`C:\Windows\System32`, APPDATA: 'allowed-appdata', TEMP: fixture.temp, TMP: fixture.temp });
});

test('owned fixture uses sibling directories and refuses deletion with a live child', async () => {
  const fixture = await createFixture();
  try {
    for (const name of ['workspace', 'temp', 'outside']) assert.equal(path.dirname(fixture[name]), fixture.root);
    assert.equal(await fs.readFile(fixture.baseline, 'utf8'), 'relay-acl-baseline-v1');
    await assert.rejects(removeOwnedFixture(fixture.root, { activeProcesses: 1 }), /child/);
    assert.ok((await fs.stat(fixture.root)).isDirectory());
  } finally { await removeOwnedFixture(fixture.root); }
  await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
});

test('probe parsing validates the wire protocol and removes untrusted extra fields', () => {
  const probe = successfulProbe('workspace-write');
  probe.secret = 'credential'; probe.workspace.extra = String.raw`C:\Users\private\anything`;
  const parsed = parseProbe(wire(probe), 'workspace-write');
  assert.equal(parsed.secret, undefined);
  assert.equal(parsed.workspace.extra, undefined);
  assert.equal(parseProbe(`${wire(probe)}unexpected output`, 'workspace-write'), null);
  assert.equal(parseProbe(wire(probe), 'read-only'), null);
  assert.equal(parseProbe(wire({ ...probe, baselineMatches: 'true' }), 'workspace-write'), null);
  probe.workspace.sha256 = 'credential';
  assert.equal(parseProbe(wire(probe), 'workspace-write'), null);
});

test('fake complete carrier verifies exit, wire data, persisted files, and cleanup without ACL calls', async () => {
  const fake = fakeCarrier();
  const report = await verifyHarness(OPTIONS, { invoke: fake.invoke, prepareExecutables: async () => TOOLS });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(fake.calls.map((call) => call.stage), ['bare-runner', 'read-only-exit-mirror', 'workspace-write', 'read-only']);
  assert.equal(report.cleanup.ok, true);
  assert.equal(report.artifacts['workspace-write'].hostFiles.proofExistsAndMatches, true);
  assert.equal(report.artifacts['read-only'].hostFiles.workspace.exists, false);
  const rendered = JSON.stringify(report);
  assert.equal(rendered.includes(fake.calls[0].fixture.root), false);
  assert.equal(rendered.includes(os.tmpdir()), false);
  assert.equal(rendered.includes(OPTIONS.executable), false);
  await assert.rejects(fs.stat(fake.calls[0].fixture.root), { code: 'ENOENT' });
});

test('verification uses the prepared automatic runner without guessing the legacy snapshot root', async () => {
  const fake = fakeCarrier();
  const automatic = parseCli(['--bin', OPTIONS.executable]);
  const report = await verifyHarness(automatic, { invoke: fake.invoke, prepareExecutables: async () => ({ ...TOOLS, runner: DEFAULT_RUNNER }) });
  assert.equal(report.ok, true);
  assert.equal(fake.calls[0].args[0], DEFAULT_RUNNER);
});

test('exit zero and marker data cannot replace the required host file evidence', async () => {
  const fake = fakeCarrier({ omitWorkspaceFile: true });
  const report = await verifyHarness(OPTIONS, { invoke: fake.invoke, prepareExecutables: async () => TOOLS });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === 'workspace-write:workspace-host-file-state').ok, false);
  assert.equal(report.cleanup.ok, true);
});

test('read-only standing-grant writes and ambiguous denied errors fail verification', async () => {
  const fake = fakeCarrier({ change(probe) {
    if (probe.mode === 'read-only') probe.workspace = { written: true, denied: false, exists: true, contentMatches: true, sha256: hash(CONTENT.workspace) };
    if (probe.mode === 'workspace-write') probe.outside.denied = false;
  } });
  const report = await verifyHarness(OPTIONS, { invoke: fake.invoke, prepareExecutables: async () => TOOLS });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === 'workspace-write:outside-access-denied').ok, false);
  assert.equal(report.checks.find((check) => check.name === 'read-only:workspace-access-denied').ok, false);
});

test('native error diagnostics never echo fixture paths or credentials and cleanup warnings fail', async () => {
  const secret = 'sk-DO-NOT-PRINT-TEST-CREDENTIAL';
  const fake = fakeCarrier({ appendStderr: `windows-acl-run: cleanup: C:\\Users\\private ${secret}\n` });
  const report = await verifyHarness(OPTIONS, { invoke: fake.invoke, prepareExecutables: async () => TOOLS });
  assert.equal(report.ok, false);
  assert.equal(report.runs.find((run) => run.name === 'workspace-write').stderr.cleanupFailureSignature, true);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes('C:\\Users\\private'), false);
  assert.equal(report.cleanup.ok, true);
});

test('a completed timed-out invocation fails even if it later has an expected exit code', async () => {
  const fake = fakeCarrier();
  const report = await verifyHarness(OPTIONS, { prepareExecutables: async () => TOOLS, invoke: async (call) => ({ ...await fake.invoke(call), timedOut: call.stage === 'read-only-exit-mirror' }) });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === 'read-only-exit-mirror:process-completed').ok, false);
  assert.equal(report.cleanup.ok, true);
});

test('timeout invokes taskkill for the whole tree with shell disabled and waits for close', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => assert.fail('Completed child must not be abandoned.');
  const spawnProcess = (executable, args, spawnOptions) => {
    calls.push({ executable, args, spawnOptions });
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    if (calls.length === 1) return child;
    const killer = new EventEmitter();
    killer.kill = () => assert.fail('Fake taskkill should complete.');
    setImmediate(() => { killer.emit('close', 0); setImmediate(() => child.emit('close', null, 'SIGKILL')); });
    return killer;
  };
  const run = await runCommand({ executable: OPTIONS.executable, args: [OPTIONS.runner], timeoutMs: 5, taskkill: TOOLS.taskkill, spawnProcess });
  assert.equal(run.timedOut, true);
  assert.equal(run.finished, true);
  assert.equal(run.treeKillSucceeded, true);
  assert.equal(calls[1].executable, TOOLS.taskkill);
  assert.deepEqual(calls[1].args, ['/PID', '4321', '/T', '/F']);
});

test('an unfinished child prevents fixture cleanup and cannot produce a passing report', async () => {
  let fixture;
  const report = await verifyHarness(OPTIONS, { prepareExecutables: async () => TOOLS, invoke: async (call) => {
    fixture = call.fixture;
    return { ...result(127, '', 'windows-acl-run: missing --workspace\n'), finished: false, timedOut: true, treeKillSucceeded: false };
  } });
  try {
    assert.equal(report.ok, false);
    assert.equal(report.cleanup.ok, false);
    assert.equal(report.runs.length, 1);
    assert.ok((await fs.stat(fixture.root)).isDirectory());
  } finally {
    // This fake has no real process; the test now explicitly owns cleanup.
    await removeOwnedFixture(fixture.root);
  }
});

test('a carrier that does not reach the runner is stopped before any ACL operation', async () => {
  const calls = [];
  const report = await verifyHarness(OPTIONS, { prepareExecutables: async () => TOOLS, invoke: async (call) => {
    calls.push(call);
    return result(0, 'unexpected carrier entry\n');
  } });
  assert.equal(report.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(report.checks.find((check) => check.name === 'bare-runner:failure-contract').ok, false);
  assert.equal(report.cleanup.ok, true);
});
