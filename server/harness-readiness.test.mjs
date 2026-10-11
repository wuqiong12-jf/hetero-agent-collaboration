import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createProviders} from './providers.mjs';
import {Orchestrator,createInitialState} from './engine.mjs';

function probeFixture() {
  let frame={type:'capabilities',sdk:true,runtime:true,executionReady:false,runtimeCheck:'blocked',runtimeIssue:'windows-acl-entry-missing',
    sdkVersion:'fixture-sdk',reasoningEffortSupported:true,reasoningEfforts:['off','low','high','max'],detail:'PRIVATE_PROBE_DETAIL'};
  let probes=0;
  const providers=createProviders({env:{DEEPSEEK_API_KEY:'synthetic-key'},pythonBin:'/fake/python',codexBin:'/fake/codex',platform:'linux',existsSync:()=>true,
    spawn(command,args){
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;
      child.kill=()=>{child.exitCode=0;queueMicrotask(()=>child.emit('close',0));};
      if(args.includes('--probe')) {
        probes++;child.stdin=new Writable({write(_chunk,_encoding,done){done();},final(done){queueMicrotask(()=>child.stdout.write(JSON.stringify(frame)+'\n'));done();}});
      }else {
        assert.deepEqual(args,['app-server']);let input='';
        child.stdin=new Writable({write(chunk,_encoding,done){input+=chunk.toString();let end;
          while((end=input.indexOf('\n'))>=0){const message=JSON.parse(input.slice(0,end));input=input.slice(end+1);
            if(message.id!==undefined)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result:message.method==='account/read'?{account:{type:'chatgpt',email:'PRIVATE_EMAIL'}}:{}})+'\n'));
          }done();}});
      }
      return child;
    }});
  return {providers,get probes(){return probes;},set frame(value){frame=value;}};
}

test('a present SDK and key cannot turn a known broken runtime green, and explicit refresh checks new state',async()=>{
  const fixture=probeFixture();const blocked=await fixture.providers.getCapabilities();
  assert.equal(blocked.harness.sdkInstalled,true);assert.equal(blocked.harness.keyConfigured,true);assert.equal(blocked.harness.available,false);
  assert.equal(blocked.codex.available,true);assert.equal(blocked.liveReady,false);assert.equal(blocked.harness.runtimeIssue,'windows-acl-entry-missing');
  assert.match(blocked.harness.detail,/沙箱命令入口缺失/);assert.equal(JSON.stringify(blocked).includes('PRIVATE_'),false);
  fixture.frame={type:'capabilities',sdk:true,runtime:true,executionReady:true,runtimeCheck:'unverified',runtimeIssue:null};
  assert.equal((await fixture.providers.getCapabilities()).harness.available,false);assert.equal(fixture.probes,1);
  const latest=await fixture.providers.getCapabilities({refresh:true});
  assert.equal(fixture.probes,2);assert.equal(latest.harness.available,true);assert.equal(latest.harness.runtimeCheck,'unverified');assert.match(latest.harness.detail,/连接自检只检查载体文件/);
  assert.equal(latest.harness.runtimeSource,'bundled');
  fixture.frame={type:'capabilities',sdk:true,runtime:true,executionReady:true,runtimeCheck:'unverified',runtimeIssue:null,runtimeSource:'override'};
  const override=await fixture.providers.getCapabilities({refresh:true});
  assert.equal(override.harness.runtimeSource,'override');assert.match(override.harness.detail,/指定的本地运行时/);
});

test('legacy probe frames remain unverified and failed inspection never exposes probe diagnostics',async()=>{
  const fixture=probeFixture();fixture.frame={type:'capabilities',sdk:true,runtime:true};
  assert.equal((await fixture.providers.getCapabilities()).harness.runtimeCheck,'unverified');
  fixture.frame={type:'capabilities',sdk:true,runtime:true,executionReady:false,runtimeCheck:'failed',runtimeIssue:'runtime-check-failed',detail:'PRIVATE_PATH synthetic-key'};
  const result=await fixture.providers.getCapabilities({refresh:true});
  assert.equal(result.harness.available,false);assert.match(result.harness.detail,/检查失败/);assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);assert.equal(JSON.stringify(result).includes('synthetic-key'),false);
});

const task=(id,status)=>({id,title:'Fixture '+id,description:'fixture',agentId:'deepseek-builder',status,attempt:1,reviewAttempts:0,
  output:'RETAINED_'+id,feedback:'fixture feedback',dependsOn:[],criteria:[{id:'c-'+id,text:'fixture criterion',status:status==='rejected'?'failed':'pending',evidence:'fixture evidence'}]});
function blockedEngine(t,tasks) {
  const state=createInitialState();state.mode='live';state.collaborationMode='cooperative';state.phase='paused';state.tasks=tasks;state.settings.autoDispatch=false;
  const calls=[];const requests=[];
  const engine=new Orchestrator({initialState:state,providers:{getCapabilities:async options=>{requests.push(options);return {codex:{available:true},harness:{available:false,detail:'fixture runtime blocked'}};},
    runAgent:async request=>{calls.push(request);assert.equal(request.agent.provider,'codex');return {text:JSON.stringify({verdict:'accepted',criteria:[{id:'c-review',status:'passed',evidence:'fixture checked'}],feedback:'fixture accepted'})};}}});
  t.after(()=>engine.close());return {engine,calls,requests};
}
async function until(engine,predicate) {for(let i=0;i<1000;i++){const value=engine.getState();if(predicate(value))return value;await delay(2);}assert.fail('fixture did not settle');}

test('blocked DeepSeek chat preserves messages, conversation identity and budget before any model run',async t=>{
  const {engine,calls,requests}=blockedEngine(t,[]);const before=engine.getState();
  await assert.rejects(engine.action({action:'message',agentId:'deepseek-builder',text:'fixture message'}),e=>e.status===409);
  const after=engine.getState();assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.usage,before.usage);
  assert.equal(after.chatSessions['deepseek-builder'].id,before.chatSessions['deepseek-builder'].id);assert.equal(calls.length,0);
  assert.equal(requests[0].refresh,true);assert.equal(after.chatSessions['deepseek-builder'].lastError,'fixture runtime blocked');
});

test('blocked manual retry retains the rejected delivery while a Codex monitor can review another retained output',async t=>{
  const {engine,calls,requests}=blockedEngine(t,[task('retry','rejected'),task('review','reviewing')]);const before=engine.getState();
  await assert.rejects(engine.action({action:'retry',taskId:'retry'}),e=>e.status===409);
  assert.deepEqual(engine.getState().tasks,before.tasks);assert.deepEqual(engine.getState().usage,before.usage);assert.equal(calls.length,0);assert.equal(requests[0].refresh,true);
  await engine.action({action:'review',taskId:'review'});
  const after=await until(engine,s=>s.tasks[1].status==='accepted'&&s.phase==='paused');
  assert.deepEqual(after.tasks[0],before.tasks[0]);assert.equal(after.tasks[1].output,'RETAINED_review');assert.equal(calls.length,1);assert.equal(after.usage.autoWorkerCalls,0);
});

test('closing during retry preflight cannot reset a delivery or launch a late worker',async()=>{
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});const state=createInitialState();state.mode='live';state.collaborationMode='cooperative';state.phase='paused';state.tasks=[task('retry','rejected')];
  const engine=new Orchestrator({initialState:state,providers:{getCapabilities:()=>{entered();return new Promise(resolve=>{release=resolve;});},runAgent:()=>assert.fail('no late worker')}});
  const rejected=assert.rejects(engine.action({action:'retry',taskId:'retry'}),e=>e.status===503);await waiting;await engine.close();const before=engine.getState();
  release({codex:{available:true},harness:{available:true}});await rejected;assert.deepEqual(engine.getState(),before);assert.equal(engine.forceDispatch,false);
});
