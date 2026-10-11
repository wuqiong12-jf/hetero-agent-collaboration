import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const bundled = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

test('agentless Harness tool verification enforces isolated homes, positive controls and zero model calls', () => {
  const python = process.env.RELAY_PYTHON_BIN || (existsSync(bundled) ? bundled : 'python');
  const result = spawnSync(python, ['-B', path.join(project, 'scripts', 'verify_harness_readonly_test.py')], {
    cwd: project, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 9 tests/);
  assert.match(result.stderr, /OK/);
});
