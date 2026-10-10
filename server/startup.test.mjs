import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Orchestrator, createInitialState } from './engine.mjs';
import { createAppServer } from './index.mjs';

const fixtureProviders = {
  getCapabilities: async () => ({codex:{available:false},harness:{available:false}}),
  runAgent: async () => { throw new Error('Startup tests cannot call models'); },
};
async function fixtureDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-startup-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('relay-startup-test-'));
    await rm(directory, {recursive:true, force:true});
  });
  return directory;
}
function listen(app, port = 0) {
  const listening = once(app.server, 'listening');
  app.server.listen(port, '127.0.0.1');
  return listening;
}

test('owned state is created only after binding, and context identifies the ready service', async t => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, 'state.json');
  let created = 0;
  const app = createAppServer({port:0, persistencePath:path, workspace:'C:/Projects/startup-fixture', engineFactory: options => {
    assert.equal(app.server.listening, true); created++;
    return new Orchestrator({...options,providers:fixtureProviders});
  }});
  t.after(() => app.close());
  assert.equal(app.engine, undefined); assert.equal(created, 0);
  await assert.rejects(readFile(path), {code:'ENOENT'});
  await listen(app); await app.engine.flushPersistence();
  assert.equal(created, 1);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/context`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {service:'relay-agent-workbench',protocolVersion:1,workspace:'C:/Projects/startup-fixture',version:'0.5.3'});
});

test('a competing startup cannot load or overwrite the running owner snapshot', async t => {
  const directory = await fixtureDirectory(t); const path = join(directory, 'state.json');
  const saved = createInitialState(); saved.phase = 'paused'; saved.collaborationMode = 'cooperative';
  saved.tasks = [{id:'retained-startup',title:'Retained startup fixture',description:'fixture',agentId:'deepseek-builder',status:'reviewing',attempt:1,reviewAttempts:1,
    output:'RETAINED_STARTUP_OUTPUT',dependsOn:[],criteria:[{id:'c-fixture',text:'fixture condition',status:'pending'}]}];
  saved.usage.autoWorkerCalls = 3; saved.usage.workerCalls = 3;
  await writeFile(path, JSON.stringify(saved), 'utf8');
  const owner = createAppServer({port:0,persistencePath:path,engineFactory: options => new Orchestrator({...options,providers:fixtureProviders})});
  t.after(() => owner.close()); await listen(owner); await owner.engine.flushPersistence();
  const before = await readFile(path); const snapshot = owner.engine.getState(); let contenderCreated = 0;
  const contender = createAppServer({port:owner.server.address().port,persistencePath:path,engineFactory: options => {
    contenderCreated++; return new Orchestrator({...options,providers:fixtureProviders});
  }});
  t.after(() => contender.close());
  const failed = once(contender.server, 'error'); contender.server.listen(owner.server.address().port, '127.0.0.1');
  const [error] = await failed; assert.equal(error.code, 'EADDRINUSE'); await contender.close(); await sleep(25);
  assert.equal(contenderCreated, 0); assert.equal(contender.engine, undefined);
  assert.deepEqual(await readFile(path), before); assert.deepEqual(owner.engine.getState(), snapshot);
  assert.equal(owner.server.listening, true);
});

test('closing an unbound app is idempotent and never creates an owned engine', async () => {
  let created = 0;
  const app = createAppServer({engineFactory: () => { created++; throw new Error('must not initialize'); }});
  const first = app.close(); assert.equal(app.close(), first); assert.equal(await first, true);
  assert.equal(created, 0); assert.equal(app.engine, undefined);
});

test('closing while listen is pending prevents late state initialization', async () => {
  let created = 0;
  const app = createAppServer({port:0,engineFactory: () => {created++; throw new Error('must not initialize');}});
  app.server.listen(0, '127.0.0.1'); await app.close(); await sleep(15);
  assert.equal(created, 0); assert.equal(app.server.listening, false); assert.equal(app.engine, undefined);
});

test('initialization failure reports the error and releases the bound port', async () => {
  const failure = new Error('fixture engine initialization failed');
  const app = createAppServer({port:0,engineFactory: () => {throw failure;}});
  const failed = once(app.server, 'error'); app.server.listen(0, '127.0.0.1');
  const [error] = await failed; assert.equal(error, failure); assert.equal(await app.close(), true);
  assert.equal(app.engine, undefined); assert.equal(app.server.listening, false);
});

test('close waits for cleanup and HTTP shutdown, keeps its result and ends event streams', async t => {
  let releaseCleanup; let closeCalls = 0;
  const cleanup = new Promise(resolveCleanup => {releaseCleanup = resolveCleanup;});
  const engine = new Orchestrator({providers:fixtureProviders});
  const originalClose = engine.close.bind(engine);
  engine.close = () => { closeCalls++; const saved = originalClose(); return Promise.all([saved,cleanup]).then(() => false); };
  const app = createAppServer({engine,port:0}); await listen(app);
  t.after(() => {releaseCleanup(); return app.close();});
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/events`);
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
  let settled = false; const closing = app.close(); closing.then(() => {settled = true;});
  assert.equal(app.close(), closing); await sleep(15); assert.equal(settled, false); assert.equal(closeCalls, 1);
  assert.equal((await reader.read()).done, true); releaseCleanup();
  assert.equal(await closing, false); assert.equal(app.server.listening, false); assert.equal(engine.closed, true);
});
