import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Orchestrator,createInitialState} from './engine.mjs';

const available=()=>({codex:{available:true,detail:'fake'},harness:{available:true,detail:'fake'},liveReady:true});
function reviewTask(overrides={}) {
  return {id:'review-origin',title:'Verify retained delivery',description:'fixture scope',agentId:'deepseek-builder',
    status:'reviewing',attempt:1,dependsOn:[],output:'SAME_DELIVERY',feedback:'EARLIER_VALID_FEEDBACK',
    criteria:[{id:'proof-1',text:'first original condition',status:'passed',evidence:'earlier retained evidence'},
      {id:'proof-2',text:'second original condition',status:'pending'}],...overrides};
}
function initial(tasks,settings={}) {
  const state=createInitialState();state.mode='live';state.collaborationMode='cooperative';state.tasks=tasks;
  Object.assign(state.settings,settings);return state;
}
function verdict(task,result='accepted') {
  return {text:JSON.stringify({verdict:result,criteria:task.criteria.map(item=>({id:item.id,status:result==='accepted'?'passed':'failed',evidence:'fake independent inspection'})),feedback:result==='accepted'?'fixture passed':'FIX_ACTUAL_DELIVERY'})};
}
async function until(engine,predicate,timeout=2000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const state=engine.getState();if(predicate(state))return state;await sleep(2);}
  assert.fail('condition not reached: '+JSON.stringify(engine.getState()));
}
function held(calls,args) {
  return new Promise((resolve,reject)=>{
    const abort=()=>setTimeout(()=>reject(Object.assign(new Error('fake process reaped'),{name:'AbortError',cleanupConfirmed:true})),2);
    args.signal.addEventListener('abort',abort,{once:true});
    calls.push({...args,resolve(value){if(!args.signal.aborted){args.signal.removeEventListener('abort',abort);resolve(value);}},reject});
  });
}

test('invalid review then valid acceptance uses the same worker delivery and unlocks downstream only after acceptance',async t=>{
  const origin=reviewTask({status:'queued',attempt:0,output:undefined});
  const downstream=reviewTask({id:'downstream',agentId:'deepseek-tester',status:'queued',attempt:0,output:undefined,dependsOn:[origin.id],criteria:[{id:'down-proof',text:'downstream condition',status:'pending'}]});
  const calls=[];const engine=new Orchestrator({initialState:initial([origin,downstream]),providers:{getCapabilities:available,runAgent:args=>held(calls,args)},demoDelayMs:1});t.after(()=>engine.close());
  await engine.action({action:'start'});await until(engine,()=>calls.length===1);
  calls[0].resolve({text:'SAME_DELIVERY'});await until(engine,()=>calls.length===2);
  const delivered=engine.getState().tasks[0];
  calls[1].resolve({text:'not JSON'});await until(engine,()=>calls.length===3);
  const waiting=engine.getState();
  assert.equal(waiting.usage.workerCalls,1);assert.equal(waiting.tasks[0].attempt,1);
  assert.equal(waiting.tasks[0].output,delivered.output);assert.deepEqual(waiting.tasks[0].criteria,delivered.criteria);
  assert.equal(waiting.tasks[0].feedback,delivered.feedback);assert.equal(waiting.tasks[0].reviewAttempts,2);
  assert.equal(waiting.tasks[1].status,'queued');assert.ok(waiting.tasks[0].reviewError);
  assert.ok(calls[2].prompt.includes('SAME_DELIVERY'));assert.ok(calls[2].prompt.includes('上次核查未完成'));
  calls[2].resolve(verdict(origin));await until(engine,()=>calls.length===4);
  assert.equal(engine.getState().tasks[0].status,'accepted');assert.equal(engine.getState().tasks[0].reviewError,undefined);
  assert.equal(engine.getState().tasks[1].status,'running');
  calls[3].resolve({text:'DOWNSTREAM_DELIVERY'});await until(engine,()=>calls.length===5);
  calls[4].resolve(verdict(downstream));const completed=await until(engine,s=>s.phase==='completed');
  assert.equal(completed.usage.workerCalls,2);assert.equal(completed.usage.supervisorCalls,3);
  assert.equal(completed.tasks[0].attempt,1);
});

test('review limits stop malformed replies without changing evidence or allowing resume, manual review, or leader changes to reset counts',async t=>{
  for(const maxReviewRetries of [0,2]){
    const origin=reviewTask();let calls=0;
    const engine=new Orchestrator({initialState:initial([origin],{maxReviewRetries}),providers:{getCapabilities:available,runAgent:async()=>{calls++;return{text:'invalid JSON'};}},demoDelayMs:1});t.after(()=>engine.close());
    await engine.action({action:'start'});const stopped=await until(engine,s=>s.phase==='blocked');
    assert.equal(calls,1+maxReviewRetries);assert.equal(stopped.tasks[0].reviewAttempts,calls);
    assert.equal(stopped.usage.workerCalls,0);assert.equal(stopped.tasks[0].status,'reviewing');
    assert.equal(stopped.tasks[0].output,origin.output);assert.deepEqual(stopped.tasks[0].criteria,origin.criteria);
    assert.equal(stopped.tasks[0].feedback,origin.feedback);assert.equal(stopped.tasks[0].attempt,1);
    await engine.action({action:'resume'});await until(engine,s=>s.phase==='blocked');
    await assert.rejects(engine.action({action:'review',taskId:origin.id}),error=>error.status===409);
    await engine.action({action:'leader',agentId:'deepseek-tester'});
    await engine.action({action:'collaboration',mode:'independent'});
    await engine.action({action:'collaboration',mode:'cooperative'});
    await engine.action({action:'resume'});await until(engine,s=>s.phase==='blocked');await sleep(15);
    assert.equal(calls,1+maxReviewRetries);assert.equal(engine.getState().tasks[0].reviewAttempts,calls);
    await engine.action({action:'settings',settings:{maxReviewRetries:maxReviewRetries+1}});
    await engine.action({action:'review',taskId:origin.id});await until(engine,s=>s.phase==='blocked');
    assert.equal(calls,2+maxReviewRetries);assert.equal(engine.getState().usage.workerCalls,0);
  }
});

test('monitor and provider budgets stop re-review before reserving another call',async t=>{
  for(const budget of ['monitor','provider']){
    const origin=reviewTask();const state=initial([origin],{maxReviewRetries:10});
    if(budget==='monitor')state.settings.maxSupervisorCalls=1;else state.settings.maxProviderCalls.codex=1;
    let calls=0;const engine=new Orchestrator({initialState:state,providers:{getCapabilities:available,runAgent:async()=>{calls++;return{text:'bad'};}},demoDelayMs:1});t.after(()=>engine.close());
    await engine.action({action:'start'});const stopped=await until(engine,s=>s.phase==='blocked');
    assert.equal(calls,1);assert.equal(stopped.tasks[0].reviewAttempts,1);
    assert.equal(stopped.usage.autoSupervisorCalls,1);assert.equal(stopped.usage.autoProviderCalls.codex,1);
    assert.equal(stopped.usage.workerCalls,0);assert.equal(stopped.tasks[0].status,'reviewing');
    assert.match(stopped.error,/调用.*预算/);assert.equal(stopped.tasks[0].output,origin.output);
  }
});

test('review transport failure blocks for attention but retrying the review never reruns a worker',async t=>{
  const origin=reviewTask();let calls=0;
  const engine=new Orchestrator({initialState:initial([origin]),providers:{getCapabilities:available,runAgent:async()=>{calls++;if(calls===1)throw new Error('fake network failure');return verdict(origin);}},demoDelayMs:1});t.after(()=>engine.close());
  await engine.action({action:'start'});const stopped=await until(engine,s=>s.phase==='blocked');
  assert.equal(stopped.tasks[0].status,'reviewing');assert.match(stopped.tasks[0].reviewError,/fake network/);
  assert.equal(stopped.tasks[0].reviewAttempts,1);assert.deepEqual(stopped.tasks[0].criteria,origin.criteria);
  await engine.action({action:'resume'});const completed=await until(engine,s=>s.phase==='completed');
  assert.equal(calls,2);assert.equal(completed.usage.workerCalls,0);assert.equal(completed.tasks[0].reviewError,undefined);
  assert.equal(completed.tasks[0].output,origin.output);
});

test('cancelled review calls remain counted through handoff and durable restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'relay-review-test-'));assert.ok(directory.startsWith(join(tmpdir(),'relay-review-test-')));
  const persistencePath=join(directory,'state.json');const origin=reviewTask();const calls=[];
  const engine=new Orchestrator({initialState:initial([origin]),persistencePath,providers:{getCapabilities:available,runAgent:args=>held(calls,args)},demoDelayMs:1});
  let restored;t.after(async()=>{await engine.close();await restored?.close();rmSync(directory,{recursive:true,force:true});});
  await engine.action({action:'start'});await until(engine,()=>calls.length===1);
  await engine.action({action:'pause'});await until(engine,s=>s.executionSummary.readers===0);
  assert.equal(engine.getState().tasks[0].reviewAttempts,1);
  await engine.action({action:'leader',agentId:'deepseek-tester'});
  await engine.action({action:'resume'});await until(engine,()=>calls.length===2);
  assert.equal(engine.getState().tasks[0].reviewAttempts,2);
  calls[0].resolve(verdict(origin,'rejected'));
  await engine.action({action:'pause'});await until(engine,s=>s.executionSummary.readers===0);
  await engine.flushPersistence();await engine.close();
  assert.equal(JSON.parse(readFileSync(persistencePath,'utf8')).tasks[0].reviewAttempts,2);
  let newCalls=0;restored=new Orchestrator({persistencePath,providers:{getCapabilities:available,runAgent:async()=>{newCalls++;return verdict(origin);}},demoDelayMs:1});
  await restored.action({action:'resume'});await until(restored,s=>s.phase==='blocked');
  assert.equal(newCalls,0);assert.equal(restored.getState().tasks[0].reviewAttempts,2);
  assert.deepEqual(restored.getState().tasks[0].criteria,origin.criteria);
  await restored.action({action:'settings',settings:{maxReviewRetries:2}});
  await restored.action({action:'review',taskId:origin.id});const done=await until(restored,s=>s.phase==='completed');
  assert.equal(newCalls,1);assert.equal(done.tasks[0].reviewAttempts,3);assert.equal(done.usage.workerCalls,0);
});

test('a valid rejected verdict still repairs delivery and resets review attempts only when the next worker starts',async t=>{
  const origin=reviewTask({status:'queued',attempt:0,output:undefined});const calls=[];
  const engine=new Orchestrator({initialState:initial([origin],{autoDispatch:false}),providers:{getCapabilities:available,runAgent:args=>held(calls,args)},demoDelayMs:1});t.after(()=>engine.close());
  await engine.action({action:'start'});await until(engine,()=>calls.length===1);
  calls[0].resolve({text:'FIRST_DELIVERY'});await until(engine,()=>calls.length===2);
  calls[1].resolve(verdict(origin,'rejected'));const rejected=await until(engine,s=>s.tasks[0].status==='rejected');
  assert.equal(rejected.tasks[0].reviewAttempts,1);assert.equal(rejected.tasks[0].reviewError,undefined);
  assert.equal(rejected.tasks[0].feedback,'FIX_ACTUAL_DELIVERY');
  await engine.action({action:'retry',taskId:origin.id});await until(engine,()=>calls.length===3);
  const rerun=engine.getState();assert.equal(rerun.tasks[0].attempt,2);assert.equal(rerun.tasks[0].reviewAttempts,0);
  assert.ok(calls[2].prompt.includes('FIX_ACTUAL_DELIVERY'));
  calls[2].resolve({text:'FIXED_DELIVERY'});await until(engine,()=>calls.length===4);
  calls[3].resolve(verdict(origin));const completed=await until(engine,s=>s.phase==='completed');
  assert.equal(completed.usage.workerCalls,2);assert.equal(completed.tasks[0].reviewAttempts,1);
});

test('extra review configuration is bounded and old snapshots gain defaults without inference',async t=>{
  const state=initial([reviewTask()]);delete state.settings.maxReviewRetries;
  let calls=0;const engine=new Orchestrator({initialState:state,providers:{getCapabilities:available,runAgent:async()=>{calls++;throw new Error('must not run');}}});t.after(()=>engine.close());
  assert.equal(engine.getState().settings.maxReviewRetries,1);assert.equal(engine.getState().tasks[0].reviewAttempts,0);
  for(const maxReviewRetries of [-1,11,1.5,'2',null])await assert.rejects(engine.action({action:'settings',settings:{maxReviewRetries}}));
  await engine.action({action:'settings',settings:{maxReviewRetries:0}});
  await engine.action({action:'settings',settings:{maxReviewRetries:10}});
  assert.equal(calls,0);assert.equal(engine.getState().tasks[0].reviewAttempts,0);
});
