import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkspaceBinding } from '../server/workspace.mjs';
import { migrateWorkspace, parseMigrationCli } from './migrate-workspace.mjs';

const execute = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./migrate-workspace.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function stoppedState() {
  return {
    id: 'migration-fixture', goal: 'PRIVATE_GOAL_DO_NOT_PRINT', phase: 'paused', mode: 'live', collaborationMode: 'cooperative', leaderId: 'leader', epoch: 7,
    agents: [{ id: 'leader', provider: 'codex', status: 'idle' }, { id: 'worker', provider: 'deepseek', status: 'idle' }],
    tasks: Array.from({ length: 4 }, (_, index) => ({ id: `task-${index}`, title: `Retained task ${index}`, description: 'Synthetic retained description', agentId: 'worker', status: index === 0 ? 'accepted' : 'queued', attempt: index + 1, reviewAttempts: 2,
      output: `PRIVATE_OUTPUT_${index}`, dependsOn: index ? ['task-0'] : [], criteria: [{ id: `condition-${index}`, text: 'Retain evidence', status: index === 0 ? 'passed' : 'pending', evidence: 'PRIVATE_EVIDENCE' }] })),
    messages: [{ id: 'm', text: 'PRIVATE_CHAT_DO_NOT_PRINT', role: 'assistant', agentId: 'leader' }],
    settings: { maxWorkerCalls: 12, maxSupervisorCalls: 9, maxProviderCalls: { codex: 10, deepseek: 12 } },
    usage: { workerCalls: 6, supervisorCalls: 3, inputTokens: 239, outputTokens: 193, autoWorkerCalls: 6, autoSupervisorCalls: 3, providerCalls: { codex: 3, deepseek: 6 } },
    chatSessions: { leader: { id: 'leader-chat', status: 'idle', providerSession: { provider: 'codex', id: 'PRIVATE_NATIVE_REFERENCE' } }, worker: { id: 'worker-chat', status: 'idle' } },
    chatArchives: { archived: { status: 'idle', text: 'PRIVATE_ARCHIVED_CHAT' } }, pendingCleanup: [],
    executionSummary: { readers: 0, writers: 0, retiringReaders: 0, retiringWriters: 0 }, revision: 12345,
  };
}

async function fixture(t, saved = stoppedState(), raw) {
  const root = await fs.mkdtemp(join(tmpdir(), 'relay-workspace-migrate-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('relay-workspace-migrate-test-'));
    const stat = await fs.lstat(root); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isDirectory(), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  const parent = join(root, 'state-parent'); const workspace = join(root, 'original workspace');
  await fs.mkdir(parent); await fs.mkdir(workspace);
  const statePath = join(parent, 'state [保留].json');
  const bytes = Buffer.from(raw ?? `${JSON.stringify(saved, null, 2).replaceAll('\n', '\r\n')}\r\n`, 'utf8');
  await fs.writeFile(statePath, bytes);
  return { root, parent, workspace, statePath, bytes, saved, args: { statePath, workspace, expectedSha256: hash(bytes) } };
}

async function unchanged(f) {
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  assert.deepEqual(await fs.readdir(f.parent), [basename(f.statePath)]);
}

test('CLI requires explicit absolute original paths and an exact byte hash without defaults', () => {
  const statePath = resolve(tmpdir(), 'state.json'); const workspace = resolve(tmpdir(), 'original'); const expectedSha256 = 'a'.repeat(64);
  assert.deepEqual(parseMigrationCli(['--state', statePath, '--workspace', workspace, '--expected-sha256', expectedSha256]), { statePath, workspace, expectedSha256 });
  assert.deepEqual(parseMigrationCli(['--help']), { help: true });
  const valid = ['--state', statePath, '--workspace', workspace, '--expected-sha256', expectedSha256];
  for (const args of [[], ['--state'], valid.slice(0, 4), [...valid, '--state', statePath], [...valid, '--unknown', 'value'], ['--help', ...valid],
    ['--state', 'state.json', '--workspace', workspace, '--expected-sha256', expectedSha256], ['--state', statePath, '--workspace', 'original', '--expected-sha256', expectedSha256],
    ['--state', statePath, '--workspace', workspace, '--expected-sha256', 'not-a-hash']]) assert.throws(() => parseMigrationCli(args), { code: 'RELAY_MIGRATION_ARGUMENTS' });
  if (process.platform === 'win32') assert.throws(() => parseMigrationCli(['--state', '\\rooted.json', '--workspace', workspace, '--expected-sha256', expectedSha256]), { code: 'RELAY_MIGRATION_ARGUMENTS' });
});

test('migration adds only the explicit canonical binding and preserves four tasks, evidence, usage and native references', async t => {
  const f = await fixture(t);
  const result = await migrateWorkspace({ ...f.args, expectedSha256: f.args.expectedSha256.toUpperCase() });
  const bytes = await fs.readFile(f.statePath); const migrated = JSON.parse(bytes);
  assert.deepEqual(migrated.workspaceBinding, createWorkspaceBinding(f.workspace));
  delete migrated.workspaceBinding; assert.deepEqual(migrated, f.saved);
  assert.equal(migrated.phase, 'paused'); assert.equal(migrated.tasks.length, 4);
  assert.deepEqual(result, { status: 'migrated', success: true, previousSha256: hash(f.bytes), sha256: hash(bytes) });
  assert.deepEqual(await fs.readdir(f.parent), [basename(f.statePath)]);
});

test('every allowed stopped phase can migrate without a phase reset', async t => {
  for (const phase of ['idle', 'paused', 'completed', 'blocked']) await t.test(phase, async t => {
    const state = stoppedState(); state.phase = phase; const f = await fixture(t, state);
    await migrateWorkspace(f.args); assert.equal(JSON.parse(await fs.readFile(f.statePath)).phase, phase);
  });
});

test('cancelled static tasks migrate without resetting their retained task data', async t => {
  const state = stoppedState(); state.tasks[1].status = 'cancelled'; const f = await fixture(t, state);
  await migrateWorkspace(f.args); const migrated = JSON.parse(await fs.readFile(f.statePath));
  delete migrated.workspaceBinding; assert.deepEqual(migrated, state);
});

test('paused pending-review delivery migrates with output, review attempts, criteria and usage intact', async t => {
  const state = stoppedState(); state.tasks[1].status = 'reviewing'; state.tasks[1].output = 'Retained delivered artifact awaiting independent review';
  state.tasks[1].reviewAttempts = 3; state.tasks[1].criteria[0].evidence = 'Retained file and check evidence'; const f = await fixture(t, state);
  await migrateWorkspace(f.args); const migrated = JSON.parse(await fs.readFile(f.statePath));
  assert.equal(migrated.phase, 'paused'); assert.equal(migrated.tasks[1].status, 'reviewing');
  assert.deepEqual(migrated.tasks[1], state.tasks[1]); assert.deepEqual(migrated.usage, state.usage);
  delete migrated.workspaceBinding; assert.deepEqual(migrated, state);
});

test('pending-review without retained output or outside a paused phase is refused', async t => {
  for (const [name, change] of [['empty output', s => { s.tasks[1].output = ''; }], ['missing output', s => { delete s.tasks[1].output; }], ['unpaused review', s => { s.phase = 'idle'; }]]) await t.test(name, async t => {
    const state = stoppedState(); state.tasks[1].status = 'reviewing'; change(state); const f = await fixture(t, state);
    await assert.rejects(migrateWorkspace(f.args), { code: 'RELAY_MIGRATION_NOT_STOPPED' }); await unchanged(f);
  });
});

test('active tasks, agents, chats, cleanup and nonzero execution summaries cannot migrate', async t => {
  const cases = [
    ['running phase', s => { s.phase = 'running'; }], ['running task', s => { s.tasks[1].status = 'running'; }], ['reviewing without output', s => { s.tasks[1].status = 'reviewing'; s.tasks[1].output = ''; }],
    ['active agent', s => { s.agents[1].status = 'running'; }], ['stopping agent', s => { s.agents[1].status = 'stopping'; }], ['active chat', s => { s.chatSessions.worker.status = 'running'; }],
    ['unconfirmed cleanup', s => { s.pendingCleanup.push({ runId: 'old-model' }); }], ['writer count', s => { s.executionSummary.writers = 1; }],
    ['invalid count', s => { s.executionSummary.readers = '0'; }], ['empty summary', s => { s.executionSummary = {}; }], ['missing summary', s => { delete s.executionSummary; }],
    ['missing cleanup', s => { delete s.pendingCleanup; }], ['missing chats', s => { delete s.chatSessions; }], ['missing agent chat', s => { delete s.chatSessions.worker; }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const state = stoppedState(); change(state); const f = await fixture(t, state);
    await assert.rejects(migrateWorkspace(f.args), { code: 'RELAY_MIGRATION_NOT_STOPPED' }); await unchanged(f);
  });
});

test('existing and malformed binding fields are refused rather than rebound', async t => {
  for (const [name, change] of [['binding', s => { s.workspaceBinding = { version: 1, directory: 'original' }; }], ['null binding', s => { s.workspaceBinding = null; }], ['legacy field', s => { s.workspace = 'original'; }]]) await t.test(name, async t => {
    const state = stoppedState(); change(state); const f = await fixture(t, state);
    await assert.rejects(migrateWorkspace(f.args), { code: 'RELAY_MIGRATION_ALREADY_BOUND' }); await unchanged(f);
  });
});

test('malformed state structure, JSON and stale expected hashes preserve the original file', async t => {
  const cases = [['tasks', s => { s.tasks = null; }], ['agents', s => { s.agents[1].id = s.agents[0].id; }], ['provider', s => { s.agents[1].provider = 'unknown'; }],
    ['messages', s => { s.messages = {}; }], ['settings', s => { s.settings = []; }], ['usage', s => { s.usage = null; }], ['mode', s => { s.mode = 'unknown'; }],
    ['acceptance', s => { s.tasks[1].criteria = []; }], ['dependency', s => { s.tasks[1].dependsOn = ['missing']; }]];
  for (const [name, change] of cases) await t.test(name, async t => {
    const state = stoppedState(); change(state); const f = await fixture(t, state);
    await assert.rejects(migrateWorkspace(f.args), { code: 'RELAY_MIGRATION_INVALID' }); await unchanged(f);
  });
  await t.test('invalid JSON', async t => { const f = await fixture(t, undefined, '{PRIVATE_BROKEN_JSON'); await assert.rejects(migrateWorkspace(f.args), { code: 'RELAY_MIGRATION_INVALID' }); await unchanged(f); });
  await t.test('hash mismatch', async t => { const f = await fixture(t); await assert.rejects(migrateWorkspace({ ...f.args, expectedSha256: '0'.repeat(64) }), { code: 'RELAY_MIGRATION_HASH_MISMATCH' }); await unchanged(f); });
});

test('missing workspaces and workspace files are refused before writing', async t => {
  const f = await fixture(t);
  await assert.rejects(migrateWorkspace({ ...f.args, workspace: join(f.root, 'missing') })); await unchanged(f);
  await assert.rejects(migrateWorkspace({ ...f.args, workspace: f.statePath })); await unchanged(f);
});

test('a snapshot changed during temp preparation fails comparison and retains the newer bytes', async t => {
  const f = await fixture(t); const newer = Buffer.from(JSON.stringify({ ...f.saved, revision: 98765 })); let wrote = false;
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    if (flags !== 'wx') return handle;
    return { stat: (...args) => handle.stat(...args), sync: () => handle.sync(), close: () => handle.close(), writeFile: async bytes => { await handle.writeFile(bytes); await fs.writeFile(f.statePath, newer); wrote = true; } };
  } } }), { code: 'RELAY_MIGRATION_COMPARE_FAILED' });
  assert.equal(wrote, true); assert.deepEqual(await fs.readFile(f.statePath), newer); assert.deepEqual(await fs.readdir(f.parent), [basename(f.statePath)]);
});

test('even an identical-byte replacement file is refused when the file identity changes', async t => {
  const f = await fixture(t);
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode); if (flags !== 'wx') return handle;
    return { stat: (...args) => handle.stat(...args), sync: () => handle.sync(), close: () => handle.close(), writeFile: async bytes => {
      await handle.writeFile(bytes); const replacement = join(f.parent, 'replacement.json'); await fs.writeFile(replacement, f.bytes); await fs.rename(replacement, f.statePath);
    } };
  } } }), { code: 'RELAY_MIGRATION_COMPARE_FAILED' });
  await unchanged(f);
});

test('write and atomic rename failures remove only the owned temp and preserve the destination', async t => {
  for (const failure of ['write', 'rename']) await t.test(failure, async t => {
    const f = await fixture(t); const removed = []; const ops = { unlink: async path => { removed.push(path); return fs.unlink(path); } };
    if (failure === 'rename') ops.rename = async () => { throw Object.assign(new Error('synthetic lock'), { code: 'EPERM' }); };
    else ops.open = async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode); if (flags !== 'wx') return handle;
      return { stat: (...args) => handle.stat(...args), sync: () => handle.sync(), close: () => handle.close(), writeFile: async () => { throw new Error('synthetic write failure'); } };
    };
    await assert.rejects(migrateWorkspace(f.args, { fileOps: ops })); await unchanged(f);
    assert.equal(removed.length, 1); assert.notEqual(removed[0], f.statePath); assert.equal(dirname(removed[0]), await fs.realpath(f.parent)); assert.match(basename(removed[0]), /\.workspace-migration\.tmp$/);
  });
});

test('exclusive temp creation never deletes a preexisting colliding file', async t => {
  const f = await fixture(t); let collision;
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { open: async (path, flags, mode) => {
    if (flags === 'wx') { collision = path; await fs.writeFile(path, 'OTHER_TEMP_OWNER'); }
    return fs.open(path, flags, mode);
  }, unlink: () => assert.fail('A failed exclusive open does not own any temp file.') } }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes); assert.equal(await fs.readFile(collision, 'utf8'), 'OTHER_TEMP_OWNER');
});

test('lstat rejects a redirected state link before opening it', async t => {
  const f = await fixture(t); let opened = 0;
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { lstat: async (path, options) => {
    const stat = await fs.lstat(path, options); if (path !== f.statePath) return stat;
    return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
  }, open: async (...args) => { opened++; return fs.open(...args); } } }), { code: 'RELAY_MIGRATION_PATH_CHANGED' });
  assert.equal(opened, 0); await unchanged(f);
});

test('an actual directory link cannot redirect the immediate state parent', async t => {
  const f = await fixture(t); const link = join(f.root, 'linked-parent');
  await fs.symlink(f.parent, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(migrateWorkspace({ ...f.args, statePath: join(link, basename(f.statePath)) }), { code: 'RELAY_MIGRATION_PATH_CHANGED' }); await unchanged(f);
});

test('replacing the parent after preparation refuses rename and does not delete through the replacement directory', async t => {
  const f = await fixture(t); const moved = join(f.root, 'moved-parent'); const decoy = Buffer.from('OTHER_PARENT_OWNER'); let temporaryName;
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode); if (flags !== 'wx') return handle; temporaryName = basename(path);
    return { stat: (...args) => handle.stat(...args), sync: () => handle.sync(), writeFile: bytes => handle.writeFile(bytes), close: async () => {
      // Windows protects the parent while the temp handle is open. Redirect it
      // immediately after close to exercise the next parent identity check.
      await handle.close(); await fs.rename(f.parent, moved); await fs.mkdir(f.parent); await fs.writeFile(f.statePath, decoy); await fs.writeFile(join(f.parent, temporaryName), 'OTHER_TEMP_OWNER');
    } };
  }, rename: () => assert.fail('A changed parent cannot be used for rename.'), unlink: () => assert.fail('A changed parent cannot be used for cleanup.') } }), { code: 'RELAY_MIGRATION_PATH_CHANGED' });
  assert.deepEqual(await fs.readFile(join(moved, basename(f.statePath))), f.bytes);
  assert.deepEqual(await fs.readFile(f.statePath), decoy); assert.equal(await fs.readFile(join(f.parent, temporaryName), 'utf8'), 'OTHER_TEMP_OWNER');
});

test('a parent redirected at the end of the final comparison is checked again before rename', async t => {
  const f = await fixture(t); const moved = join(f.root, 'moved-after-comparison'); let reads = 0;
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    if (path !== f.statePath || typeof flags !== 'number' || ++reads !== 2) return handle;
    return { stat: (...args) => handle.stat(...args), readFile: () => handle.readFile(), close: async () => {
      await handle.close(); await fs.rename(f.parent, moved); await fs.mkdir(f.parent); await fs.writeFile(f.statePath, 'OTHER_PARENT_AFTER_COMPARISON');
    } };
  }, rename: () => assert.fail('Final comparison does not authorize a redirected parent.'), unlink: () => assert.fail('Cleanup cannot follow the redirected parent.') } }), { code: 'RELAY_MIGRATION_PATH_CHANGED' });
  assert.deepEqual(await fs.readFile(join(moved, basename(f.statePath))), f.bytes); assert.equal(await fs.readFile(f.statePath, 'utf8'), 'OTHER_PARENT_AFTER_COMPARISON');
});

test('a replaced temporary file is neither committed nor deleted as our own', async t => {
  const f = await fixture(t); let temporary;
  await assert.rejects(migrateWorkspace(f.args, { fileOps: { open: async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode); if (flags !== 'wx') return handle; temporary = path;
    return { stat: (...args) => handle.stat(...args), sync: () => handle.sync(), writeFile: bytes => handle.writeFile(bytes), close: async () => {
      await handle.close(); const replacement = join(f.parent, 'other-temp.json'); await fs.writeFile(replacement, 'OTHER_TEMP_AFTER_CLOSE'); await fs.rename(replacement, temporary);
    } };
  }, rename: () => assert.fail('A replaced temporary file cannot be committed.'), unlink: () => assert.fail('A replaced temporary file is not owned by this migration.') } }), { code: 'RELAY_MIGRATION_PATH_CHANGED' });
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes); assert.equal(await fs.readFile(temporary, 'utf8'), 'OTHER_TEMP_AFTER_CLOSE');
});

test('CLI output contains only status, success and hashes and explains the stop-service boundary', async t => {
  const f = await fixture(t);
  const result = await execute(process.execPath, [scriptPath, '--state', f.statePath, '--workspace', f.workspace, '--expected-sha256', f.args.expectedSha256]);
  assert.equal(result.stderr, ''); assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['previousSha256', 'sha256', 'status', 'success']);
  assert.equal(result.stdout.includes('PRIVATE_'), false); assert.equal(result.stdout.includes(f.workspace), false); assert.equal(result.stdout.includes(f.statePath), false);
  let failure; try { await execute(process.execPath, [scriptPath, '--state', f.statePath, '--workspace', f.workspace, '--expected-sha256', hash(await fs.readFile(f.statePath))]); } catch (error) { failure = error; }
  assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.deepEqual(JSON.parse(failure.stderr), { status: 'RELAY_MIGRATION_ALREADY_BOUND', success: false }); assert.equal(failure.stderr.includes('PRIVATE_'), false);
  const help = await execute(process.execPath, [scriptPath, '--help']); assert.match(help.stdout, /stop the old service/i); assert.match(help.stdout, /does not acquire a\s+cross-process lock/i); assert.match(help.stdout, /never inferred from task content/i);
});
