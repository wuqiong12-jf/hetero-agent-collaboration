import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,promises as files} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {Orchestrator,createInitialState} from './engine.mjs';

const available=()=>({codex:{available:true,detail:'fixture'},harness:{available:true,detail:'fixture'},liveReady:true});
function task(overrides={}) {
  return {id:'retained',title:'Review retained fixture',description:'fixture scope',agentId:'deepseek-builder',status:'reviewing',
    attempt:1,reviewAttempts:1,output:'RETAINED_DELIVERY',dependsOn:[],criteria:[{id:'c-one',text:'fixture criterion',status:'pending'}],...overrides};
}
function initial(tasks) {const state=createInitialState();state.mode='live';state.collaborationMode='cooperative';state.phase='paused';state.tasks=tasks;return state;}
async function until(engine,predicate) {
  for(let n=0;n<1000;n++){const state=engine.getState();if(predicate(state))return state;await sleep(2);}
  assert.fail('fixture did not settle');
}
function ownedDirectory() {
  const prefix=join(tmpdir(),'relay-recovery-test-');
  const directory=mkdtempSync(prefix);assert.ok(directory.startsWith(prefix));return directory;
}

test('resume diagnosis respects a budget-blocked writer ahead of retained review, while manual review remains possible',async t=>{
  const state=initial([task(),task({id:'writer',status:'queued',attempt:0,reviewAttempts:0,output:undefined})]);
  state.settings.maxProviderCalls.deepseek=1;state.usage.autoProviderCalls.deepseek=1;state.settings.autoDispatch=false;
  let calls=0;
  const engine=new Orchestrator({initialState:state,providers:{getCapabilities:available,runAgent:async()=>{
    calls++;return {text:JSON.stringify({verdict:'accepted',criteria:[{id:'c-one',status:'passed',evidence:'fixture evidence'}],feedback:'fixture accepted'})};
  }}});
  t.after(()=>engine.close());
  assert.equal(engine.getState().recovery.summary.resume.allowed,false);
  await engine.action({action:'resume'});
  await until(engine,s=>s.phase==='blocked');assert.equal(calls,0);
  assert.equal(engine.getState().recovery.summary.resume.allowed,false);
  await engine.action({action:'review',taskId:'retained'});
  const reviewed=await until(engine,s=>s.tasks[0].status==='accepted'&&s.phase==='paused');
  assert.equal(calls,1);assert.equal(reviewed.tasks[0].output,'RETAINED_DELIVERY');assert.equal(reviewed.tasks[1].attempt,0);
});

test('an exhausted first review prevents automatic recovery from falling through to a ready reader',async t=>{
  const state=initial([task({reviewAttempts:2}),task({id:'reader',status:'queued',attempt:0,reviewAttempts:0,output:undefined})]);
  state.agents.find(a=>a.id==='deepseek-builder').accessMode='read-only';let calls=0;
  const engine=new Orchestrator({initialState:state,providers:{getCapabilities:available,runAgent:async()=>{calls++;throw new Error('must not start');}}});
  t.after(()=>engine.close());
  assert.equal(engine.getState().recovery.summary.resume.allowed,false);
  await engine.action({action:'resume'});await until(engine,s=>s.phase==='blocked');assert.equal(calls,0);
  assert.equal(engine.getState().tasks[1].attempt,0);
});

test('manual review checks only the actual monitor channel before spending attempts or budget',async t=>{
  const state=initial([task()]);state.settings.autoReview=false;state.settings.autoDispatch=false;
  let ready=false;let calls=0;let checks=0;
  const engine=new Orchestrator({initialState:state,providers:{getCapabilities:()=>{checks++;return {codex:{available:ready},harness:{available:false}};},
    runAgent:async()=>{calls++;return {text:JSON.stringify({verdict:'accepted',criteria:[{id:'c-one',status:'passed',evidence:'fixture evidence'}],feedback:'fixture accepted'})};}}});
  t.after(()=>engine.close());
  const before=engine.getState();
  await assert.rejects(engine.action({action:'review',taskId:'retained'}),e=>e.status===409);
  assert.deepEqual(engine.getState().usage,before.usage);assert.deepEqual(engine.getState().tasks,before.tasks);
  assert.equal(engine.getState().phase,'paused');assert.equal(calls,0);
  ready=true;await engine.action({action:'review',taskId:'retained'});
  const after=await until(engine,s=>s.phase==='completed');
  assert.equal(checks,2);assert.equal(calls,1);assert.equal(after.tasks[0].reviewAttempts,2);assert.equal(after.tasks[0].attempt,1);
});

test('closing the service during a manual review channel check cannot reserve a late call',async()=>{
  let release;let entered;const waiting=new Promise(resolve=>{entered=resolve;});let calls=0;
  const engine=new Orchestrator({initialState:initial([task()]),providers:{getCapabilities:()=>{entered();return new Promise(resolve=>{release=resolve;});},runAgent:async()=>{calls++;throw new Error('must not start');}}});
  const before=engine.getState();const pending=engine.action({action:'review',taskId:'retained'});await waiting;
  await engine.close();release(available());await assert.rejects(pending,e=>e.status===503);
  assert.equal(calls,0);assert.deepEqual(engine.getState().usage,before.usage);assert.deepEqual(engine.getState().tasks,before.tasks);
});

test('snapshot recovery is read-only, uses the actual fallback actor, and is not written as persistent state',async t=>{
  const directory=ownedDirectory();const path=join(directory,'state.json');
  const state=initial([task({id:'accepted',status:'accepted',criteria:[{id:'c-old',text:'old result',status:'passed',evidence:'fixture'}]}),task(),
    task({id:'next',status:'queued',attempt:0,output:undefined,agentId:'codex-supervisor',dependsOn:['accepted']})]);
  state.settings.maxSupervisorCalls=1;state.usage.autoSupervisorCalls=1;
  state.settings.maxProviderCalls.deepseek=2;state.usage.autoProviderCalls.deepseek=2;
  state.activity=[{type:'cooperative-goal',at:'2026-10-11T00:00:00.000Z'},{type:'accepted',taskId:'accepted',at:'2026-10-11T00:01:00.000Z'}];
  let capabilities=0;let runs=0;
  const engine=new Orchestrator({initialState:state,persistencePath:path,providers:{getCapabilities:()=>{capabilities++;return available();},runAgent:async()=>{runs++;throw new Error('snapshot must not infer');}}});
  t.after(async()=>{await engine.close();rmSync(directory,{recursive:true,force:true});});
  await engine.flushPersistence();
  const before=structuredClone(engine.state);const snapshot=engine.getState();const second=engine.getState();
  assert.deepEqual(engine.state,before);assert.deepEqual(snapshot,second);assert.equal(capabilities,0);assert.equal(runs,0);
  assert.equal(snapshot.recovery.summary.progress.accepted,1);assert.equal(snapshot.recovery.summary.progress.reviewing,1);
  assert.equal(snapshot.recovery.summary.lastAccepted.taskId,'accepted');
  assert.ok(snapshot.recovery.summary.steps.find(s=>s.taskId==='retained').issues.some(i=>i.settingKey==='maxSupervisorCalls'));
  const next=snapshot.recovery.summary.steps.find(s=>s.taskId==='next');
  assert.ok(next.issues.some(i=>i.settingKey==='maxProviderCalls.deepseek'));
  assert.equal(next.issues.some(i=>i.settingKey==='maxProviderCalls.codex'),false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path,'utf8')),'recovery'),false);
  snapshot.recovery.summary.progress.accepted=99;
  assert.equal(engine.getState().recovery.summary.progress.accepted,1);
});

test('retrySave confirms persistence only and preserves pause, retained outputs, attempts and usage',async t=>{
  const directory=ownedDirectory();const path=join(directory,'state.json');let locked=false;let runs=0;let capabilityChecks=0;
  const engine=new Orchestrator({initialState:initial([task()]),persistencePath:path,persistenceRetryDelays:[1],
    fileOps:{rename:async(from,to)=>{if(locked)throw Object.assign(new Error('fixture lock'),{code:'EPERM'});return files.rename(from,to);}},
    providers:{getCapabilities:()=>{capabilityChecks++;return available();},runAgent:async()=>{runs++;throw new Error('save must not infer');}}});
  t.after(async()=>{locked=false;await engine.close();rmSync(directory,{recursive:true,force:true});});
  await engine.flushPersistence();locked=true;
  await assert.rejects(engine.action({action:'saveGoalBrief',expectedRevision:0,brief:{objective:'draft',deliverables:'',acceptance:'',constraints:'',questions:''}}),e=>e.status===503);
  const stopped=engine.getState();assert.ok(stopped.recovery.summary.globalIssues.some(i=>i.code==='persistence-failed'));
  await assert.rejects(engine.action({action:'retrySave'}),e=>e.status===503);
  locked=false;const saved=await engine.action({action:'retrySave'});await sleep(12);
  assert.equal(saved.phase,'paused');assert.equal(engine.getState().phase,'paused');assert.equal(runs,0);assert.equal(capabilityChecks,0);
  assert.deepEqual(saved.tasks,stopped.tasks);assert.deepEqual(saved.usage,stopped.usage);
  assert.equal(saved.recovery.summary.globalIssues.some(i=>i.code==='persistence-failed'),false);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).goalDraft.objective,'draft');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path,'utf8')),'recovery'),false);
});

test('a successful save retry cannot release a persistent cleanup barrier or start a model',async t=>{
  const directory=ownedDirectory();const path=join(directory,'state.json');const state=initial([task()]);
  state.pendingCleanup=[{runId:'fixture-unconfirmed',agentId:'deepseek-builder',kind:'worker',accessMode:'read-only',reason:'fixture cleanup'}];
  let locked=false;let runs=0;
  const engine=new Orchestrator({initialState:state,persistencePath:path,persistenceRetryDelays:[1],
    fileOps:{rename:async(from,to)=>{if(locked)throw Object.assign(new Error('fixture lock'),{code:'EPERM'});return files.rename(from,to);}},
    providers:{getCapabilities:available,runAgent:async()=>{runs++;throw new Error('barrier must prevent inference');}}});
  t.after(async()=>{locked=false;await engine.close();rmSync(directory,{recursive:true,force:true});});
  await engine.flushPersistence();locked=true;
  await assert.rejects(engine.action({action:'saveGoalBrief',expectedRevision:0,brief:{objective:'draft',deliverables:'',acceptance:'',constraints:'',questions:''}}));
  locked=false;const saved=await engine.action({action:'retrySave'});
  assert.equal(saved.phase,'blocked');assert.equal(saved.pendingCleanup.length,1);assert.equal(saved.recovery.summary.resume.allowed,false);
  assert.ok(saved.recovery.summary.globalIssues.some(i=>i.code==='cleanup-unconfirmed'&&i.action==='none'));
  await assert.rejects(engine.action({action:'resume'}),e=>e.status===503);
  assert.equal(runs,0);assert.equal(JSON.parse(readFileSync(path,'utf8')).pendingCleanup.length,1);
});

test('recovery resumes the retained review and skips accepted work despite exhausted worker budget',async t=>{
  const accepted=task({id:'already-accepted',status:'accepted'});const retained=task();
  const state=initial([accepted,retained]);state.settings.maxWorkerCalls=1;
  state.usage.workerCalls=1;state.usage.autoWorkerCalls=1;
  const calls=[];const engine=new Orchestrator({initialState:state,providers:{getCapabilities:available,runAgent:async args=>{
    calls.push(args);return{text:JSON.stringify({verdict:'accepted',criteria:[{id:'c-one',status:'passed',evidence:'fixture independent check'}],feedback:'fixture accepted'})};
  }},demoDelayMs:1});t.after(()=>engine.close());
  const summary=engine.getState().recovery.summary;
  assert.equal(summary.resume.allowed,true);assert.equal(summary.steps.find(s=>s.taskId==='retained').issues.some(i=>i.code==='worker-budget'),false);
  await engine.action({action:'resume'});const completed=await until(engine,s=>s.phase==='completed');
  assert.equal(calls.length,1);assert.equal(calls[0].agent.id,'codex-supervisor');
  assert.equal(completed.usage.workerCalls,1);assert.equal(completed.tasks[0].attempt,1);
  assert.equal(completed.tasks[1].attempt,1);assert.equal(completed.tasks[1].output,'RETAINED_DELIVERY');
});
