import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('.', import.meta.url));
const checkout = fileURLToPath(new URL('..', import.meta.url));
const localPython = join(checkout, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3';
const fingerprint = content => ({ [createHash('sha256').update(content).digest('hex')]: Buffer.byteLength(content) });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-runtime-check-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('relay-runtime-check-')); rmSync(root, { recursive: true, force: true }); });
  return root;
}

function pythonJson(root, script, payload, extraEnv = {}) {
  // All provider credentials and modules are synthetic. -S avoids installed
  // SDK packages, and -B prevents bytecode writes in the checkout.
  const env = {
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    PATH: process.env.PATH,
    PYTHONPATH: [root, server].join(process.platform === 'win32' ? ';' : ':'),
    PYTHONIOENCODING: 'utf-8',
    ...extraEnv,
  };
  const result = spawnSync(python, ['-B', '-S', '-c', script], {
    cwd: root, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout.trim());
}

const inspectScript = `
import json, sys
from harness_runtime import inspect_runtime
payload = json.load(sys.stdin)
print(json.dumps(inspect_runtime(payload['launch'], platform=payload.get('platform', 'win32'),
                                 known_bad_fingerprints=payload.get('fingerprints', {}))))
`;

function inspect(root, launch, fingerprints = {}, platform = 'win32') {
  return pythonJson(root, inspectScript, { launch, fingerprints, platform });
}

test('known bad Windows carrier blocks only after its size and SHA256 match', t => {
  const root = fixture(t);
  const carrier = join(root, 'fake-runtime.exe');
  const content = 'synthetic known broken carrier';
  writeFileSync(carrier, content);
  const result = inspect(root, [carrier], fingerprint(content));
  assert.equal(result.runtimeCheck, 'blocked');
  assert.equal(result.executionReady, false);
  assert.equal(result.runtimeIssue, 'windows-acl-entry-missing');
  assert.match(result.detail, /Windows Harness.*ACL.*启动检查未通过/);
  assert.equal(result.detail.includes(root), false);

  const wrongSize = Object.fromEntries(Object.entries(fingerprint(content)).map(([hash, size]) => [hash, size + 1]));
  assert.equal(inspect(root, [carrier], wrongSize).runtimeCheck, 'unverified');
});

test('unknown Windows carrier stays unverified and same-size different content is allowed', t => {
  const root = fixture(t);
  const carrier = join(root, 'fake-runtime.exe');
  writeFileSync(carrier, 'fixture-a');
  const result = inspect(root, [carrier], fingerprint('fixture-b'));
  assert.equal(result.runtimeCheck, 'unverified');
  assert.equal(result.executionReady, true);
  assert.equal(result.runtimeIssue, null);
  assert.notEqual(result.runtimeCheck, 'verified');
});

test('changing a carrier at the same path is rechecked without stale cached acceptance or rejection', t => {
  const root = fixture(t);
  const carrier = join(root, 'fake-runtime.exe');
  const original = 'fixture-a';
  writeFileSync(carrier, original);
  const result = pythonJson(root, `
import json, sys
from pathlib import Path
from harness_runtime import inspect_runtime
payload = json.load(sys.stdin)
path = Path(payload['launch'][0])
checks = [inspect_runtime(payload['launch'], platform='win32', known_bad_fingerprints=payload['fingerprints'])]
path.write_bytes(b'fixture-b')
checks.append(inspect_runtime(payload['launch'], platform='win32', known_bad_fingerprints=payload['fingerprints']))
path.write_bytes(b'fixture-a')
checks.append(inspect_runtime(payload['launch'], platform='win32', known_bad_fingerprints=payload['fingerprints']))
print(json.dumps(checks))
`, { launch: [carrier], fingerprints: fingerprint(original) });
  assert.deepEqual(result.map(item => item.runtimeCheck), ['blocked', 'unverified', 'blocked']);
});

test('non-Windows and Node carriers are not blocked or advertised as verified', t => {
  const root = fixture(t);
  const carrier = join(root, 'fake-runtime.exe');
  const script = join(root, 'fake-bin.js');
  const content = 'synthetic known broken carrier';
  writeFileSync(carrier, content);
  writeFileSync(script, 'synthetic script; never executed');
  const nonWindows = inspect(root, [carrier], fingerprint(content), 'linux');
  assert.equal(nonWindows.runtimeCheck, 'not-applicable');
  assert.equal(nonWindows.executionReady, true);
  const node = inspect(root, [carrier, script], fingerprint(content));
  assert.equal(node.runtimeCheck, 'unverified');
  assert.equal(node.executionReady, true);
});

test('unreadable, non-file and missing Node carriers fail without exposing private paths', t => {
  const root = fixture(t);
  const privatePath = join(root, 'private-user-folder', 'secret-runtime.exe');
  const directory = join(root, 'private-directory');
  mkdirSync(directory);
  const carrier = join(root, 'fake-node.exe');
  writeFileSync(carrier, 'synthetic node; never executed');
  for (const launch of [[], [privatePath], [directory], [carrier, privatePath]]) {
    const result = inspect(root, launch);
    assert.equal(result.runtimeCheck, 'failed');
    assert.equal(result.executionReady, false);
    assert.equal(result.runtimeIssue, 'runtime-check-failed');
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
  const permissionDenied = pythonJson(root, `
import builtins, json, sys
from harness_runtime import inspect_runtime
payload = json.load(sys.stdin)
def denied(*args, **kwargs):
    raise PermissionError('private-user-folder/secret-runtime.exe synthetic permission denied')
builtins.open = denied
print(json.dumps(inspect_runtime(payload['launch'], platform='win32')))
`, { launch: [carrier] });
  assert.equal(permissionDenied.executionReady, false);
  assert.equal(JSON.stringify(permissionDenied).includes('private-user-folder'), false);
});

function fakeSdk(root, carrier, { supportsDshBin = true } = {}) {
  const policyDirectory = join(root, 'synthetic-policy-directory');
  mkdirSync(policyDirectory);
  writeFileSync(join(root, 'deepseek_harness.py'), `
import json, os
from dataclasses import dataclass
from pathlib import Path
@dataclass
class DeepSeekHarnessConfig:
    reasoning_effort: str | None = None
    ${supportsDshBin ? 'dsh_bin: str | None = None' : '# Synthetic old SDK has no public dsh_bin field.'}
class DeepSeekHarness:
    def __init__(self, **kwargs):
        captured = {**kwargs, 'policy': Path(kwargs['patches'][0]).read_text(encoding='utf-8')}
        Path(os.environ['CONSTRUCTOR_MARKER']).write_text(json.dumps(captured), encoding='utf-8')
        raise RuntimeError('synthetic constructor stop; no model call')
    def run(self, *args, **kwargs):
        Path(os.environ['RUN_MARKER']).write_text('run called')
        raise RuntimeError('synthetic run forbidden')
`);
  writeFileSync(join(root, 'deepseek_harness_runtime.py'), `
import os
from pathlib import Path
def resolve_bundled_launch_args():
    Path(os.environ['RESOLVER_MARKER']).write_text('resolved', encoding='utf-8')
    if os.environ.get('BUNDLED_FORBIDDEN') == '1':
        raise AssertionError('bundled runtime resolver must not be used for override')
    return (os.environ['FIXTURE_RUNTIME'],)
`);
  for (const name of ['deepseek_harness_sdk', 'deepseek_harness_runtime_bin']) {
    const info = join(root, `${name}-0.1.5rc1.dist-info`);
    mkdirSync(info);
    writeFileSync(join(info, 'METADATA'), `Metadata-Version: 2.1\nName: ${name.replaceAll('_', '-')}\nVersion: 0.1.5rc1\n`);
  }
  return {
    FIXTURE_RUNTIME: carrier,
    DEEPSEEK_API_KEY: 'synthetic-fixture-key',
    CONSTRUCTOR_MARKER: join(root, 'constructor-marker'),
    RUN_MARKER: join(root, 'run-marker'),
    RESOLVER_MARKER: join(root, 'resolver-marker'),
    POLICY_DIRECTORY: policyDirectory,
    POLICY_TEMP_MARKER: join(root, 'policy-temp-marker'),
  };
}

const bridgeSetup = `
import json, sys
import harness_runtime
payload = json.load(sys.stdin)
original_inspect = harness_runtime.inspect_runtime
checked_launches = []
harness_runtime.inspect_runtime = lambda launch: (checked_launches.append(list(launch)) or
    original_inspect(launch, platform='win32', known_bad_fingerprints=payload['fingerprints']))
import harness_bridge
# Confined Windows test accounts can read fixture files but cannot resolve
# ancestors of the temporary directory in strict mode. Only this synthetic
# workspace bypasses that OS restriction; runtime selection remains unchanged.
original_resolve = harness_bridge.Path.resolve
def fixture_resolve(path, *args, **kwargs):
    if kwargs.get('strict') and str(path) == payload.get('run', {}).get('workspace'):
        return original_resolve(path)
    return original_resolve(path, *args, **kwargs)
harness_bridge.Path.resolve = fixture_resolve
# Use a Node-prepared fixture directory for policy writes. Windows restricted
# tokens can deny a Python-created directory's descendants; this unit test
# checks the policy and public constructor arguments rather than OS ACLs.
class FixturePolicyDirectory:
    def __init__(self, *, prefix, dir):
        assert prefix == 'relay-harness-policy-'
        assert str(dir) == payload['run']['home']
        harness_bridge.Path(harness_bridge.os.environ['POLICY_TEMP_MARKER']).write_text('entered', encoding='utf-8')
    def __enter__(self):
        return harness_bridge.os.environ['POLICY_DIRECTORY']
    def __exit__(self, *args):
        return False
harness_bridge.tempfile.TemporaryDirectory = FixturePolicyDirectory
`;

test('bridge probe distinguishes installed SDK/runtime from blocked execution readiness', t => {
  const root = fixture(t);
  const carrier = join(root, 'fake-runtime.exe');
  const content = 'synthetic known broken carrier';
  writeFileSync(carrier, content);
  const env = fakeSdk(root, carrier);
  const result = pythonJson(root, `${bridgeSetup}\nharness_bridge.probe()\n`, { fingerprints: fingerprint(content) }, env);
  assert.equal(result.type, 'capabilities');
  assert.equal(result.sdk, true);
  assert.equal(result.runtime, true);
  assert.equal(result.sdkVersion, '0.1.5rc1');
  assert.equal(result.runtimeVersion, '0.1.5rc1');
  assert.equal(result.runtimeSource, 'bundled');
  assert.equal(result.executionReady, false);
  assert.equal(result.runtimeCheck, 'blocked');
  assert.equal(result.runtimeIssue, 'windows-acl-entry-missing');
  assert.equal(existsSync(env.CONSTRUCTOR_MARKER), false);
  assert.equal(existsSync(env.RUN_MARKER), false);
  assert.equal(existsSync(env.POLICY_TEMP_MARKER), false);

  writeFileSync(carrier, 'changed unknown runtime');
  const changed = pythonJson(root, `${bridgeSetup}\nharness_bridge.probe()\n`, { fingerprints: fingerprint(content) }, env);
  assert.equal(changed.sdkVersion, '0.1.5rc1');
  assert.equal(changed.runtimeCheck, 'unverified');
  assert.equal(changed.executionReady, true);
});

test('bridge run rechecks bad carrier before SDK construction, run or home creation', t => {
  const root = fixture(t);
  const carrier = join(root, 'fake-runtime.exe');
  const content = 'synthetic known broken carrier';
  writeFileSync(carrier, 'synthetic initially unknown carrier');
  const env = fakeSdk(root, carrier);
  const home = join(root, 'must-not-create-home');
  const result = pythonJson(root, `${bridgeSetup}
from pathlib import Path
probe_output = []
harness_bridge.emit = probe_output.append
harness_bridge.probe()
Path(payload['carrier']).write_text(payload['badContent'], encoding='utf-8')
try:
    harness_bridge.run(payload['run'])
except RuntimeError as error:
    print(json.dumps({'probe': probe_output[0], 'error': str(error)}))
`, { fingerprints: fingerprint(content), carrier, badContent: content,
    run: { workspace: root, home, prompt: 'synthetic; must never reach a model' } }, env);
  assert.equal(result.probe.runtimeCheck, 'unverified');
  assert.equal(result.probe.executionReady, true);
  assert.match(result.error, /Windows Harness.*ACL.*启动检查未通过/);
  assert.equal(existsSync(env.CONSTRUCTOR_MARKER), false);
  assert.equal(existsSync(env.RUN_MARKER), false);
  assert.equal(existsSync(home), false);
});

test('bridge rejects a read failure before SDK construction and home creation without leaking paths', t => {
  const root = fixture(t);
  const env = fakeSdk(root, join(root, 'private-user-folder', 'missing-runtime.exe'));
  const home = join(root, 'must-not-create-home');
  const result = pythonJson(root, `${bridgeSetup}
try:
    harness_bridge.run(payload['run'])
except RuntimeError as error:
    print(json.dumps({'error': str(error)}))
`, { fingerprints: {}, run: { workspace: root, home, prompt: 'synthetic' } }, env);
  assert.match(result.error, /无法读取 Harness 运行时文件/);
  assert.equal(result.error.includes(root), false);
  assert.equal(result.error.includes('private-user-folder'), false);
  assert.equal(existsSync(env.CONSTRUCTOR_MARKER), false);
  assert.equal(existsSync(env.RUN_MARKER), false);
  assert.equal(existsSync(home), false);
});

const probeAndRun = `${bridgeSetup}
if 'override' in payload:
    # Native process environments cannot contain NUL. A synthetic mapping
    # exercises rejection without ever giving that value to process launch.
    harness_bridge.os.environ = {**harness_bridge.os.environ, 'RELAY_HARNESS_BIN': payload['override']}
probe_output = []
harness_bridge.emit = probe_output.append
harness_bridge.probe()
try:
    harness_bridge.run(payload['run'])
except RuntimeError as error:
    result = {'probe': probe_output[0], 'error': harness_bridge.scrub(error)}
    if 'expectedRuntime' in payload:
        expected = str(harness_bridge.Path(payload['expectedRuntime']).resolve())
        result['sameCheckedCarrier'] = checked_launches == [[expected], [expected]]
    print(json.dumps(result))
`;

function assertNoRuntimeSideEffects(env, home) {
  assert.equal(existsSync(env.RESOLVER_MARKER), false, 'invalid override must never fall back to bundled');
  assert.equal(existsSync(env.CONSTRUCTOR_MARKER), false);
  assert.equal(existsSync(env.RUN_MARKER), false);
  assert.equal(existsSync(env.POLICY_TEMP_MARKER), false);
  assert.equal(existsSync(home), false);
}

test('override probe and run select the same checked carrier through the public dsh_bin parameter', t => {
  const root = fixture(t);
  const carrier = join(root, 'private-runtime-folder', 'local Harness.EXE');
  mkdirSync(dirname(carrier));
  writeFileSync(carrier, 'synthetic override carrier; never execute');
  // The default carrier is deliberately absent, and resolving it is forbidden.
  const env = { ...fakeSdk(root, join(root, 'missing-bundled-runtime.exe')),
    RELAY_HARNESS_BIN: `  ${carrier}  `, BUNDLED_FORBIDDEN: '1' };
  const home = join(root, 'isolated-home');
  const result = pythonJson(root, probeAndRun,
    { fingerprints: {}, expectedRuntime: carrier,
      run: { workspace: root, home, prompt: 'synthetic', accessMode: 'read-only', reasoningEffort: 'high' } }, env);
  assert.equal(result.probe.sdk, true);
  assert.equal(result.probe.runtime, true);
  assert.equal(result.probe.runtimeSource, 'override');
  assert.equal(result.probe.bundledRuntimeVersion, '0.1.5rc1');
  assert.equal(result.probe.runtimeVersion, undefined);
  assert.equal(result.probe.runtimeCheck, 'unverified');
  assert.equal(result.probe.executionReady, true);
  assert.equal(result.sameCheckedCarrier, true);
  assert.equal(JSON.stringify(result.probe).includes(root), false);
  assert.match(result.error, /synthetic constructor stop/);
  const options = JSON.parse(readFileSync(env.CONSTRUCTOR_MARKER, 'utf8'));
  assert.equal(options.dsh_bin, resolve(carrier));
  assert.equal('_launch_args' in options, false);
  assert.equal(options.profile, 'sdk');
  assert.equal(options.reasoning_effort, 'high');
  assert.deepEqual(options.env, { DSH_PERMISSION_MODE: 'read-only', DSH_MAX_TOKENS_AS_SUCCESS: 'false' });
  assert.match(options.policy, /mode: read-only/);
  assert.match(options.policy, /policy: never/);
  assert.match(options.policy, /sandbox: read-only\n        approval: never/);
  assert.equal(existsSync(env.RESOLVER_MARKER), false);
  assert.equal(existsSync(env.RUN_MARKER), false);
});

test('override probe reads files only and neither constructs SDK nor executes its selected file', t => {
  const root = fixture(t);
  const carrier = join(root, 'read-only-probe.exe');
  writeFileSync(carrier, 'synthetic file that cannot be executed');
  const env = { ...fakeSdk(root, join(root, 'missing-bundled-runtime.exe')),
    RELAY_HARNESS_BIN: carrier, BUNDLED_FORBIDDEN: '1' };
  const result = pythonJson(root, `${bridgeSetup}\nharness_bridge.probe()\n`, { fingerprints: {} }, env);
  assert.equal(result.runtimeSource, 'override');
  assert.equal(result.executionReady, true);
  assertNoRuntimeSideEffects(env, join(root, 'home-not-created'));
});

test('known bad override is blocked before constructor, run, home or bundled fallback', t => {
  const root = fixture(t);
  const carrier = join(root, 'private-known-bad.exe');
  const content = 'synthetic known broken override';
  writeFileSync(carrier, content);
  const env = { ...fakeSdk(root, join(root, 'missing-bundled-runtime.exe')), RELAY_HARNESS_BIN: carrier };
  const home = join(root, 'must-not-create-home');
  const result = pythonJson(root, probeAndRun,
    { fingerprints: fingerprint(content), run: { workspace: root, home, prompt: 'synthetic' } }, env);
  assert.equal(result.probe.sdk, true);
  assert.equal(result.probe.runtime, true);
  assert.equal(result.probe.runtimeSource, 'override');
  assert.equal(result.probe.runtimeCheck, 'blocked');
  assert.equal(result.probe.executionReady, false);
  assert.match(result.error, /Windows Harness.*ACL.*启动检查未通过/);
  assert.equal(JSON.stringify(result).includes(root), false);
  assertNoRuntimeSideEffects(env, home);
});

test('override is rechecked when its carrier changes after probe and before run', t => {
  const root = fixture(t);
  const carrier = join(root, 'local-runtime.exe');
  const badContent = 'synthetic newly broken override';
  writeFileSync(carrier, 'synthetic previously unknown override');
  const env = { ...fakeSdk(root, join(root, 'missing-bundled-runtime.exe')), RELAY_HARNESS_BIN: carrier };
  const home = join(root, 'must-not-create-home');
  const result = pythonJson(root, `${bridgeSetup}
from pathlib import Path
probe_output = []
harness_bridge.emit = probe_output.append
harness_bridge.probe()
Path(payload['carrier']).write_text(payload['badContent'], encoding='utf-8')
try:
    harness_bridge.run(payload['run'])
except RuntimeError as error:
    print(json.dumps({'probe': probe_output[0], 'error': str(error)}))
`, { fingerprints: fingerprint(badContent), carrier, badContent,
    run: { workspace: root, home, prompt: 'synthetic' } }, env);
  assert.equal(result.probe.executionReady, true);
  assert.match(result.error, /Windows Harness.*ACL.*启动检查未通过/);
  assertNoRuntimeSideEffects(env, home);
});

test('empty, relative, quoted, script, command, missing and directory overrides fail closed without exposing paths', t => {
  const root = fixture(t);
  const bundled = join(root, 'good-bundled.exe');
  const carrier = join(root, 'private-carrier.exe');
  const script = join(root, 'private-script.py');
  const shebang = join(root, 'private-script-disguised.exe');
  const directory = join(root, 'private-directory.exe');
  writeFileSync(bundled, 'synthetic good bundled carrier');
  writeFileSync(carrier, 'synthetic normal carrier');
  writeFileSync(script, 'synthetic script; never execute');
  writeFileSync(shebang, '#!/bin/sh\nnever execute');
  mkdirSync(directory);
  const env = fakeSdk(root, bundled);
  const home = join(root, 'must-not-create-home');
  const invalid = ['', '  ', 'relative-runtime.exe', `${carrier}\n`, `${carrier}\u2028`, `${carrier}\0`,
    `"${carrier}"`, `${carrier} --flag`, `node ${script}`, script, shebang, directory,
    join(root, 'private-user-folder', 'missing-runtime.exe')];
  if (process.platform === 'win32') invalid.push('C:relative.exe', '\\root-relative.exe', join(root, 'private-runtime.bin'));
  for (const value of invalid) {
    const result = pythonJson(root, probeAndRun,
      { fingerprints: {}, override: value, run: { workspace: root, home, prompt: 'synthetic' } }, env);
    assert.equal(result.probe.sdk, true);
    assert.equal(result.probe.runtime, false);
    assert.equal(result.probe.runtimeSource, 'override');
    assert.equal(result.probe.runtimeCheck, 'failed');
    assert.equal(result.probe.executionReady, false);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(JSON.stringify(result).includes('private-'), false);
    assertNoRuntimeSideEffects(env, home);
  }
});

test('read failure of override remains a safe failure before home or SDK construction', t => {
  const root = fixture(t);
  const carrier = join(root, 'private-runtime.exe');
  writeFileSync(carrier, 'synthetic readable carrier until access fails');
  const env = { ...fakeSdk(root, carrier), RELAY_HARNESS_BIN: carrier };
  const home = join(root, 'must-not-create-home');
  const result = pythonJson(root, `${bridgeSetup}
import builtins
def denied(*args, **kwargs):
    raise PermissionError('private-runtime.exe synthetic access denied')
builtins.open = denied
probe_output = []
harness_bridge.emit = probe_output.append
harness_bridge.probe()
try:
    harness_bridge.run(payload['run'])
except RuntimeError as error:
    print(json.dumps({'probe': probe_output[0], 'error': str(error)}))
`, { fingerprints: {}, run: { workspace: root, home, prompt: 'synthetic' } }, env);
  assert.equal(result.probe.executionReady, false);
  assert.equal(result.probe.runtimeCheck, 'failed');
  assert.match(result.error, /无法读取 Harness 运行时文件/);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes('private-runtime'), false);
  assertNoRuntimeSideEffects(env, home);
});

test('old SDK rejects override capability for both probe and run but keeps the default bundled path', t => {
  const root = fixture(t);
  const carrier = join(root, 'override.exe');
  writeFileSync(carrier, 'synthetic selected carrier');
  const env = fakeSdk(root, carrier, { supportsDshBin: false });
  const home = join(root, 'must-not-create-home');
  const result = pythonJson(root, probeAndRun,
    { fingerprints: {}, run: { workspace: root, home, prompt: 'synthetic' } }, { ...env, RELAY_HARNESS_BIN: carrier });
  assert.equal(result.probe.sdk, true);
  assert.equal(result.probe.runtimeSource, 'override');
  assert.equal(result.probe.executionReady, false);
  assert.match(result.probe.detail, /does not support dsh_bin/);
  assert.match(result.error, /does not support dsh_bin/);
  assertNoRuntimeSideEffects(env, home);
  const bundled = pythonJson(root, `${bridgeSetup}\nharness_bridge.probe()\n`, { fingerprints: {} }, env);
  assert.equal(bundled.runtimeSource, 'bundled');
  assert.equal(bundled.executionReady, true);
  const defaultRun = pythonJson(root, `${bridgeSetup}
try:
    harness_bridge.run(payload['run'])
except RuntimeError as error:
    print(json.dumps({'error': str(error)}))
`, { fingerprints: {}, run: { workspace: root, home, prompt: 'synthetic' } }, env);
  assert.match(defaultRun.error, /synthetic constructor stop/);
  const options = JSON.parse(readFileSync(env.CONSTRUCTOR_MARKER, 'utf8'));
  assert.equal('dsh_bin' in options, false, 'default SDK keeps its official bundled resolver');
  assert.equal('_launch_args' in options, false);
  assert.equal(existsSync(env.RUN_MARKER), false);
});

test('runtime launch errors redact raw, normalized and Windows escaped override paths', t => {
  const root = fixture(t);
  const carrier = join(root, 'private-runtime.exe');
  const windowsPath = 'C:\\private-user\\local runtime.exe';
  const result = pythonJson(root, `
import json, os, sys
from pathlib import Path
import harness_bridge
payload = json.load(sys.stdin)
checks = []
for value in payload['paths']:
    os.environ['RELAY_HARNESS_BIN'] = value
    normalized = str(Path(value.strip()).resolve())
    message = f'launch failed: {value} {normalized} {value!r} {json.dumps(value)}'
    checks.append(harness_bridge.scrub(message))
# Simulate a link retargeted after carrier selection. Launch errors from the
# previously selected target must stay redacted even if normalization changes.
old_target = str(Path(payload['paths'][0]).resolve())
harness_bridge._selected_runtime_paths.add(old_target)
os.environ['RELAY_HARNESS_BIN'] = payload['paths'][1]
checks.append(harness_bridge.scrub(f'launch failed: {old_target!r}'))
print(json.dumps(checks))
`, { paths: [carrier, windowsPath] });
  for (const detail of result) {
    assert.equal(detail.includes('private-'), false);
    assert.equal(detail.includes(root), false);
    assert.match(detail, /runtime path redacted/);
  }
});
