import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as filesystem } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceBinding, WorkspaceBindingError } from '../server/workspace.mjs';

const PHASES = new Set(['idle', 'paused', 'completed', 'blocked']);
const TASK_STATUSES = new Set(['queued', 'accepted', 'rejected', 'cancelled', 'reviewing']);
const PROVIDERS = new Set(['codex', 'deepseek']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class WorkspaceMigrationError extends Error {
  constructor(message, code = 'RELAY_MIGRATION_INVALID') { super(message); this.name = 'WorkspaceMigrationError'; this.code = code; }
}

function fail(message, code) { throw new WorkspaceMigrationError(message, code); }
function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value)
    && (process.platform !== 'win32' || !['\\', '/'].includes(parse(value).root));
}

export function parseMigrationCli(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const keys = { '--state': 'statePath', '--workspace': 'workspace', '--expected-sha256': 'expectedSha256' };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (!key || Object.hasOwn(args, key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail('Require each migration argument exactly once.', 'RELAY_MIGRATION_ARGUMENTS');
    args[key] = argv[i + 1];
  }
  validateArguments(args);
  return args;
}

function validateArguments(args) {
  if (!record(args) || !absolutePath(args.statePath) || !absolutePath(args.workspace) || typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) {
    fail('Require absolute state and original workspace paths, and the current byte SHA-256. No directory is guessed.', 'RELAY_MIGRATION_ARGUMENTS');
  }
}

function validateStoppedState(saved) {
  if (!record(saved)) fail('State must be a JSON object.');
  if (Object.hasOwn(saved, 'workspaceBinding') || Object.hasOwn(saved, 'workspace')) fail('An existing binding cannot be migrated or rebound.', 'RELAY_MIGRATION_ALREADY_BOUND');
  if (!Array.isArray(saved.tasks) || saved.tasks.length > 12 || saved.tasks.some(task => !record(task) || typeof task.id !== 'string' || !task.id || typeof task.status !== 'string')
      || new Set(saved.tasks.map(task => task.id)).size !== saved.tasks.length
      || !Array.isArray(saved.agents) || saved.agents.length < 2 || saved.agents.length > 8
      || saved.agents.some(agent => !record(agent) || typeof agent.id !== 'string' || !agent.id || !PROVIDERS.has(agent.provider))
      || new Set(saved.agents.map(agent => agent.id)).size !== saved.agents.length
      || !Array.isArray(saved.messages) || saved.messages.some(message => !record(message) || typeof message.text !== 'string')
      || !record(saved.settings) || !record(saved.usage) || !['demo', 'live'].includes(saved.mode)) {
    fail('State has an invalid task, agent, message, settings, usage or mode structure.');
  }
  const agentIds = new Set(saved.agents.map(agent => agent.id));
  if (saved.tasks.some(task => typeof task.title !== 'string' || typeof task.description !== 'string' || !agentIds.has(task.agentId)
      || !Array.isArray(task.dependsOn) || task.dependsOn.some(id => typeof id !== 'string' || !saved.tasks.some(candidate => candidate.id === id))
      || !Array.isArray(task.criteria) || task.criteria.length === 0 || task.criteria.some(criterion => !record(criterion) || typeof criterion.id !== 'string' || !criterion.id || typeof criterion.text !== 'string'))) {
    fail('State has an invalid task reference or acceptance structure.');
  }
  if (!PHASES.has(saved.phase) || saved.tasks.some(task => !TASK_STATUSES.has(task.status)
      || task.status === 'reviewing' && (saved.phase !== 'paused' || typeof task.output !== 'string' || !task.output.trim()))
      || saved.agents.some(agent => agent.status !== 'idle')
      || !record(saved.chatSessions) || Object.values(saved.chatSessions).some(session => !record(session) || session.status !== 'idle')
      || saved.agents.some(agent => !Object.hasOwn(saved.chatSessions, agent.id))
      || !Array.isArray(saved.pendingCleanup) || saved.pendingCleanup.length !== 0
      || !record(saved.executionSummary) || ['readers', 'writers', 'retiringReaders', 'retiringWriters'].some(key => saved.executionSummary[key] !== 0)
      || Object.values(saved.executionSummary).some(value => value !== 0)) {
    fail('Stop the old service and confirm that every execution and cleanup has ended before migration.', 'RELAY_MIGRATION_NOT_STOPPED');
  }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameMetadata(left, right) { return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function regularFile(stat) { return stat.isFile() && !stat.isSymbolicLink(); }
function actualDirectory(stat) { return stat.isDirectory() && !stat.isSymbolicLink(); }

async function captureParent(parentPath, ops) {
  const stat = await ops.lstat(parentPath, { bigint: true });
  if (!actualDirectory(stat)) fail('The state parent must be an actual directory.', 'RELAY_MIGRATION_PATH_CHANGED');
  const canonical = await ops.realpath(parentPath);
  const canonicalStat = await ops.lstat(canonical, { bigint: true });
  if (!actualDirectory(canonicalStat) || !sameIdentity(stat, canonicalStat)) fail('The state parent changed.', 'RELAY_MIGRATION_PATH_CHANGED');
  return { requested: parentPath, canonical, stat: canonicalStat };
}

async function assertParent(parent, ops) {
  const requestedStat = await ops.lstat(parent.requested, { bigint: true });
  const canonicalStat = await ops.lstat(parent.canonical, { bigint: true });
  if (!actualDirectory(requestedStat) || !actualDirectory(canonicalStat) || !sameIdentity(parent.stat, requestedStat) || !sameIdentity(parent.stat, canonicalStat)
      || await ops.realpath(parent.requested) !== parent.canonical || await ops.realpath(parent.canonical) !== parent.canonical) {
    fail('The state parent changed; no replacement is authorized.', 'RELAY_MIGRATION_PATH_CHANGED');
  }
}

async function readSnapshot(path, ops) {
  const before = await ops.lstat(path, { bigint: true });
  if (!regularFile(before)) fail('The state must be an actual regular file, not a link.', 'RELAY_MIGRATION_PATH_CHANGED');
  const handle = await ops.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameMetadata(before, opened)) fail('The state file changed before reading.', 'RELAY_MIGRATION_PATH_CHANGED');
    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await ops.lstat(path, { bigint: true });
    if (!regularFile(afterPath) || !sameMetadata(before, afterRead) || !sameMetadata(before, afterPath)) fail('The state file changed while reading.', 'RELAY_MIGRATION_PATH_CHANGED');
    return { bytes, stat: before, sha256: digest(bytes) };
  } finally { await handle.close(); }
}

// This command requires the old service to be stopped. The hash check detects
// changes observed before rename; it is not a lock against another process that
// starts writing after the final check.
export async function migrateWorkspace(args, { fileOps = {} } = {}) {
  validateArguments(args);
  const ops = { lstat: filesystem.lstat, realpath: filesystem.realpath, open: filesystem.open, rename: filesystem.rename, unlink: filesystem.unlink, ...fileOps };
  const binding = createWorkspaceBinding(args.workspace);
  const requestedState = resolve(args.statePath);
  const parent = await captureParent(dirname(requestedState), ops);
  const target = join(parent.canonical, basename(requestedState));
  await assertParent(parent, ops);
  const original = await readSnapshot(target, ops);
  if (original.sha256 !== args.expectedSha256.toLowerCase()) fail('The expected SHA-256 does not match the current snapshot bytes.', 'RELAY_MIGRATION_HASH_MISMATCH');
  let saved;
  try { saved = JSON.parse(original.bytes.toString('utf8')); }
  catch { fail('State is not valid JSON.'); }
  validateStoppedState(saved);
  const bytes = Buffer.from(`${JSON.stringify({ ...saved, workspaceBinding: binding }, null, 2)}\n`, 'utf8');
  const temporary = join(parent.canonical, `.${basename(target)}.${randomUUID()}.workspace-migration.tmp`);
  let temporaryStat;
  let temporaryOwned = false;
  try {
    await assertParent(parent, ops);
    const handle = await ops.open(temporary, 'wx', 0o600);
    temporaryOwned = true;
    try {
      temporaryStat = await handle.stat({ bigint: true });
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await assertParent(parent, ops);
    const current = await readSnapshot(target, ops);
    if (!sameIdentity(original.stat, current.stat) || current.sha256 !== original.sha256 || !current.bytes.equals(original.bytes)) {
      fail('The snapshot changed since the initial read.', 'RELAY_MIGRATION_COMPARE_FAILED');
    }
    await assertParent(parent, ops);
    const candidate = await ops.lstat(temporary, { bigint: true });
    if (!regularFile(candidate) || !sameIdentity(candidate, temporaryStat)) fail('The prepared temporary file was replaced.', 'RELAY_MIGRATION_PATH_CHANGED');
    // Preserve the destination on every failure; never remove it to make rename work.
    await ops.rename(temporary, target);
    temporaryOwned = false;
    return { status: 'migrated', success: true, previousSha256: original.sha256, sha256: digest(bytes) };
  } finally {
    if (temporaryOwned && temporaryStat) {
      try {
        await assertParent(parent, ops);
        const current = await ops.lstat(temporary, { bigint: true });
        if (regularFile(current) && sameIdentity(current, temporaryStat)) await ops.unlink(temporary);
      } catch { /* A redirected parent or replacement temp is not ours to delete. */ }
    }
  }
}

const HELP = `Migrate one unbound Relay snapshot after stopping the old service.\n\nUsage:\n  node scripts/migrate-workspace.mjs --state <absolute-state.json> --workspace <absolute-original-directory> --expected-sha256 <current-byte-sha256>\n\nThe workspace must be the independently verified original working directory.\nIt is never inferred from task content or the current directory. Already bound,\nactive or uncleared snapshots are refused. This command does not acquire a\ncross-process lock: stop the old service before migration and keep it stopped\nuntil the command finishes. A final hash check cannot exclude a later writer.\nNormal startup continues to reject unbound snapshots.\n`;

const isMain = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseMigrationCli(process.argv.slice(2));
    if (args.help) process.stdout.write(HELP);
    else process.stdout.write(`${JSON.stringify(await migrateWorkspace(args))}\n`);
  } catch (error) {
    const status = error instanceof WorkspaceMigrationError || error instanceof WorkspaceBindingError ? error.code : 'RELAY_MIGRATION_IO_FAILED';
    process.stderr.write(`${JSON.stringify({ status, success: false })}\n`);
    process.exitCode = 1;
  }
}
