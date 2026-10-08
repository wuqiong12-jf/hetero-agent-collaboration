import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

const root = join(tmpdir(), 'relay-config-fixture');
const configPath = join(root, '.relay', 'local-config.json');
const cipherPath = join(root, '.relay', 'secrets', 'deepseek.dpapi');
const fakeCipher = 'AQIDBA==';
const fakeKey = 'TEST_ONLY_MOCK_KEY';
function fakeRead(files, requested = []) {
  return async (path, encoding) => {
    requested.push(path); assert.equal(encoding, 'utf8');
    if (files.has(path)) return files.get(path);
    throw Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
  };
}

test('existing environment values take priority and skip all secret file reads and decryption', async () => {
  const env = { RELAY_PYTHON: 'existing-python', RELAY_DEEPSEEK_MODEL: 'existing-model', RELAY_HARNESS_SOURCE: 'existing-source', DEEPSEEK_API_KEY: 'EXISTING_TEST_KEY' };
  const before = { ...env }; const requested = [];
  const files = new Map([[configPath, JSON.stringify({ RELAY_PYTHON: 'different/python.exe', RELAY_DEEPSEEK_MODEL: 'deepseek-flash', RELAY_HARNESS_SOURCE: 'different/harness' })], [cipherPath, fakeCipher]]);
  const result = await loadLocalConfig(root, { env, platform: 'linux', readFile: fakeRead(files, requested), decrypt: () => assert.fail('decryption must be skipped') });
  assert.deepEqual(env, before); assert.deepEqual(result, { configLoaded: true, keyLoaded: false });
  assert.deepEqual(requested, [configPath]);
  const emptyEnv = { DEEPSEEK_API_KEY: '' };
  await loadLocalConfig(root, { env: emptyEnv, platform: 'linux', readFile: fakeRead(new Map()), decrypt: () => assert.fail('explicitly empty env still takes priority') });
  assert.equal(emptyEnv.DEEPSEEK_API_KEY, '');
});

test('valid configuration resolves relative paths against the project and stores a mock decrypted key only in env', async () => {
  const env = {}; const requested = [];
  const config = { RELAY_PYTHON: 'runtime/python.exe', RELAY_DEEPSEEK_MODEL: 'deepseek-flash', RELAY_HARNESS_SOURCE: 'vendor/harness' };
  const result = await loadLocalConfig(root, { env, platform: 'win32', readFile: fakeRead(new Map([[configPath, `\uFEFF${JSON.stringify(config)}`], [cipherPath, `\uFEFF${fakeCipher}\r\n`]]), requested),
    decrypt: async (cipher) => { assert.equal(cipher, fakeCipher); return fakeKey; } });
  assert.equal(env.RELAY_PYTHON, join(root, 'runtime', 'python.exe'));
  assert.equal(env.RELAY_HARNESS_SOURCE, join(root, 'vendor', 'harness'));
  assert.equal(env.RELAY_DEEPSEEK_MODEL, 'deepseek-flash'); assert.equal(env.DEEPSEEK_API_KEY, fakeKey);
  assert.deepEqual(result, { configLoaded: true, keyLoaded: true });
  assert.ok(!JSON.stringify(result).includes(fakeKey));
  assert.deepEqual(requested, [configPath, cipherPath]);
});

test('absent configuration and ciphertext are optional on any platform', async () => {
  const env = {};
  assert.deepEqual(await loadLocalConfig(root, { env, platform: 'linux', readFile: fakeRead(new Map()), decrypt: () => assert.fail('no file means no decrypt') }), { configLoaded: false, keyLoaded: false });
  assert.deepEqual(env, {});
  await assert.rejects(loadLocalConfig('relative-project', { env, readFile: () => assert.fail('must reject before reading') }), /绝对路径/);
});

test('invalid JSON, unsupported fields, bad values, and read errors fail without applying or exposing contents', async () => {
  const invalid = [
    'NOT_JSON_PRIVATE_DIAGNOSTIC', 'null', '[]',
    JSON.stringify({ DEEPSEEK_API_KEY: 'NOT_ALLOWED_CLEAR_TEXT' }),
    JSON.stringify({ RELAY_PYTHON: 42 }),
    JSON.stringify({ RELAY_PYTHON: 'valid/python.exe', RELAY_DEEPSEEK_MODEL: 'bad model with spaces' }),
    JSON.stringify({ RELAY_HARNESS_SOURCE: 'bad\npath' }),
  ];
  for (const text of invalid) {
    const env = {};
    await assert.rejects(loadLocalConfig(root, { env, platform: 'win32', readFile: fakeRead(new Map([[configPath, text]])) }), (error) => {
      assert.ok(!error.message.includes('NOT_ALLOWED_CLEAR_TEXT')); assert.ok(!error.message.includes('PRIVATE_DIAGNOSTIC')); return true;
    });
    assert.deepEqual(env, {});
  }
  await assert.rejects(loadLocalConfig(root, { env: {}, readFile: async () => { throw Object.assign(new Error('PRIVATE_READ_DIAGNOSTIC'), { code: 'EACCES' }); } }), (error) => {
    assert.match(error.message, /无法读取/); assert.ok(!error.message.includes('PRIVATE_READ_DIAGNOSTIC')); return true;
  });
});

test('non-Windows DPAPI and failed decrypt report safe actionable errors without changing the environment', async () => {
  const readFile = fakeRead(new Map([[configPath, JSON.stringify({ RELAY_PYTHON: 'runtime/python.exe' })], [cipherPath, fakeCipher]]));
  const env = {};
  await assert.rejects(loadLocalConfig(root, { env, platform: 'linux', readFile, decrypt: () => assert.fail('non-Windows must not decrypt') }), (error) => {
    assert.match(error.message, /Windows DPAPI/); assert.ok(!error.message.includes(fakeCipher)); return true;
  });
  await assert.rejects(loadLocalConfig(root, { env, platform: 'win32', readFile, decrypt: async () => { throw new Error(`INTERNAL_PRIVATE_DIAGNOSTIC ${fakeCipher} ${fakeKey}`); } }), (error) => {
    assert.match(error.message, /当前 Windows 用户/); assert.ok(!error.message.includes(fakeCipher)); assert.ok(!error.message.includes(fakeKey)); assert.ok(!error.message.includes('PRIVATE_DIAGNOSTIC')); return true;
  });
  assert.deepEqual(env, {});
  await assert.rejects(loadLocalConfig(root, { env, platform: 'win32', readFile, decrypt: async () => '' }), /解密结果无效/);
});

test('fixed PowerShell invocation uses hidden pipes and stdin, never passes credential material in argv', async () => {
  const env = {}; let input = '';
  const spawn = (command, args, options) => {
    assert.equal(command, 'powershell.exe'); assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.ok(args[3].includes('ProtectedData]::Unprotect')); assert.ok(args[3].includes('CurrentUser'));
    assert.ok(!args.join(' ').includes(fakeCipher)); assert.ok(!args.join(' ').includes(fakeKey));
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    child.stdin.on('data', (chunk) => input += chunk.toString('utf8'));
    child.stdin.on('finish', () => queueMicrotask(() => {
      child.stdout.write(fakeKey); child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    }));
    return child;
  };
  const result = await loadLocalConfig(root, { env, platform: 'win32', spawn, readFile: fakeRead(new Map([[cipherPath, fakeCipher]])) });
  assert.equal(input, fakeCipher); assert.equal(env.DEEPSEEK_API_KEY, fakeKey);
  assert.deepEqual(result, { configLoaded: false, keyLoaded: true });
});
