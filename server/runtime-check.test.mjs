import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

function fakeSdk(root, carrier) {
  writeFileSync(join(root, 'deepseek_harness.py'), `
import os
from dataclasses import dataclass
from pathlib import Path
@dataclass
class DeepSeekHarnessConfig:
    reasoning_effort: str | None = None
class DeepSeekHarness:
    def __init__(self, **kwargs):
        Path(os.environ['CONSTRUCTOR_MARKER']).write_text('constructed')
        raise RuntimeError('synthetic constructor stop; no model call')
    def run(self, *args, **kwargs):
        Path(os.environ['RUN_MARKER']).write_text('run called')
        raise RuntimeError('synthetic run forbidden')
`);
  writeFileSync(join(root, 'deepseek_harness_runtime.py'), `
import os
def resolve_bundled_launch_args():
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
  };
}

const bridgeSetup = `
import json, sys
import harness_runtime
payload = json.load(sys.stdin)
original_inspect = harness_runtime.inspect_runtime
harness_runtime.inspect_runtime = lambda launch: original_inspect(launch, platform='win32',
                                                                known_bad_fingerprints=payload['fingerprints'])
import harness_bridge
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
  assert.equal(result.executionReady, false);
  assert.equal(result.runtimeCheck, 'blocked');
  assert.equal(result.runtimeIssue, 'windows-acl-entry-missing');
  assert.equal(existsSync(env.CONSTRUCTOR_MARKER), false);
  assert.equal(existsSync(env.RUN_MARKER), false);

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
