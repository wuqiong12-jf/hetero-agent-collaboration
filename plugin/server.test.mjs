import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocol,validateRequest,RESOURCE_URI,inlineBundle,tools} from './relay-native/server.mjs';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {Script} from 'node:vm';

function serviceContext(extra={}) {
  return {service:'relay-agent-workbench',protocolVersion:1,workspace:'C:\\work',version:'0.5.3',...extra};
}
function jsonResponse(data,status=200) {
  return {ok:status>=200&&status<300,status,json:async()=>structuredClone(data)};
}

test('inline packaging preserves JavaScript and CSS replacement tokens literally',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-inline-'));
  try{
    await mkdir(join(root,'assets'));
    const javascript='globalThis.packagedTokens = ["$&", "$`", "$\'", "$$", "</script>"];';
    const css='.tokens::after { content: "$& $` $\' $$"; }';
    await writeFile(join(root,'assets','app.js'),javascript);
    await writeFile(join(root,'assets','app.css'),css);
    await writeFile(join(root,'index.html'),'<html><head><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
    const html=await inlineBundle(root);
    const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length,2);
    assert.equal(scripts[1][1],javascript.replace(/<\/script/gi,'<\\/script'));
    assert.ok(html.includes('<style>'+css+'</style>'));
    const context={};
    new Script(scripts[1][1]).runInNewContext(context);
    assert.deepEqual(Array.from(context.packagedTokens),['$&','$`',"$'",'$$','</script>']);
  }finally{
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.ok(basename(root).startsWith('relay-inline-'));
    await rm(root,{recursive:true,force:true});
  }
});

test('native tool exposes sidebar and conversation entrypoints with a real icon',async()=>{
  const api=createProtocol({fetcher:async()=>{throw new Error('network should not run')}});
  const init=await api.handle('initialize',{protocolVersion:'2025-06-18'});
  assert.ok(init.serverInfo.icons[0].src.startsWith('data:image/png;base64,'));
  const tool=tools.find(row=>row.name==='open_relay_workspace');
  assert.deepEqual(tool._meta['openai/ui'].entrypoints,[{type:'global'}]);
  const panel=tools.find(row=>row.name==='open_relay_panel');
  assert.deepEqual(panel._meta['openai/ui'].entrypoints,[{type:'thread'}]);
  assert.equal(tool._meta.ui.resourceUri,RESOURCE_URI);
  const result=await api.handle('tools/call',{name:'open_relay_workspace',arguments:{view:'deepseek'}});
  assert.equal(result.structuredContent.view,'deepseek');
});
test('MCP bridge permits only scoped API routes and never arbitrary URLs',()=>{
  assert.equal(validateRequest({route:'/api/models?provider=deepseek'}).method,'GET');
  assert.throws(()=>validateRequest({route:'https://example.com/private'}));
  assert.throws(()=>validateRequest({route:'/api/../../.relay/secrets/deepseek.dpapi'}));
  assert.throws(()=>validateRequest({route:'/api/actions',method:'GET'}));
  assert.throws(()=>validateRequest({route:'/api/state',body:{something:true}}));
});
test('UI state and explicit user actions go through MCP without model calls',async()=>{
  const calls=[];
  const api=createProtocol({fetcher:async(url,options)=>{
    calls.push({path:url.pathname,method:options.method});
    if(url.pathname==='/api/context')return jsonResponse(serviceContext());
    return {ok:true,status:200,json:async()=>({mode:'live',collaborationMode:'independent'})};
  }});
  const result=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/actions',method:'POST',body:{action:'collaboration',mode:'independent'}}});
  assert.equal(result.structuredContent.data.collaborationMode,'independent');
  assert.deepEqual(calls.map(row=>row.path),['/api/context','/api/actions']);
  assert.deepEqual(result.content,[]);
});

test('goal brief save and confirm actions pass through the private UI transport unchanged',async()=>{
  const posts=[];
  const brief={objective:'目标',deliverables:'交付一份报告',acceptance:'结果与证据可核查',constraints:'限定当前工作目录',questions:''};
  const api=createProtocol({fetcher:async(url,options={})=>{
    if(url.pathname==='/api/context')return jsonResponse(serviceContext());
    assert.equal(url.pathname,'/api/actions');assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);posts.push(body);
    const goalDraft={...brief,revision:1,updatedAt:'2026-10-09T01:00:00Z',...(body.action==='confirmGoalBrief'?{confirmedAt:'2026-10-09T01:01:00Z'}:{})};
    return {ok:true,status:200,json:async()=>({revision:posts.length,mode:'live',leaderId:'codex-supervisor',goalDraft,
      ...(body.action==='confirmGoalBrief'?{activeBrief:{...goalDraft,confirmedAt:'2026-10-09T01:01:00Z'}}:{})})};
  }});
  const bodies=[{action:'saveGoalBrief',brief,expectedRevision:0},{action:'confirmGoalBrief',revision:1,expectedMode:'live',expectedLeaderId:'codex-supervisor'}];
  for(const body of bodies){
    const result=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/actions',method:'POST',body}});
    assert.equal(result.isError,undefined);assert.equal(result.structuredContent.ok,true);assert.deepEqual(result.content,[]);
  }
  assert.deepEqual(posts,bodies);
  assert.equal(posts.some(body=>['start','review','cooperativeGoal'].includes(body.action)),false);
});

test('reachable unrelated, legacy and incompatible services never receive actions or trigger startup',async()=>{
  const cases=[
    {context:serviceContext({service:'unrelated-service'}),error:/不是 Relay/},
    {context:{workspace:'C:\\old-project',version:'0.5.2'},error:/旧版.*重启/},
    {context:serviceContext({protocolVersion:2}),error:/协议不兼容/},
    {context:serviceContext({protocolVersion:'1'}),error:/协议不兼容/},
    {context:serviceContext({workspace:null}),error:/上下文无效/},
    {context:{status:'ok',private:'PRIVATE_RESPONSE'},error:/不是 Relay/},
    {status:404,context:{error:'PRIVATE_RESPONSE'},error:/无法确认/},
    {brokenJson:true,error:/上下文无法读取/},
  ];
  for(const scenario of cases){
    const calls=[];let starts=0;
    const api=createProtocol({startService:async()=>{starts++;},fetcher:async(url,options={})=>{
      calls.push({path:url.pathname,method:options.method||'GET'});
      assert.equal(url.pathname,'/api/context');
      if(scenario.brokenJson)return {ok:true,status:200,json:async()=>{throw new Error('PRIVATE_BODY_ERROR');}};
      return jsonResponse(scenario.context,scenario.status||200);
    }});
    const result=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/actions',method:'POST',body:{action:'message',agentId:'worker',text:'PRIVATE_TASK'}}});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.status,503);
    assert.match(result.structuredContent.error,scenario.error);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
    assert.equal(starts,0);assert.deepEqual(calls,[{path:'/api/context',method:'GET'}]);
  }
});

test('team tools refuse an unrelated service before reading team state or delegating',async()=>{
  for(const name of ['agent_team_status','delegate_agent_task']){
    const calls=[];let starts=0;
    const api=createProtocol({startService:async()=>{starts++;},fetcher:async url=>{
      calls.push(url.pathname);return jsonResponse({status:'ok'});
    }});
    await assert.rejects(api.handle('tools/call',{name,arguments:name==='delegate_agent_task'?{agentId:'worker',task:'任务',criteria:['验收']}:{}}),/不是 Relay/);
    assert.deepEqual(calls,['/api/context']);assert.equal(starts,0);
  }
});

test('each completed request rechecks service identity while compatible release versions remain usable',async()=>{
  let context=serviceContext({version:'0.6.0'}),starts=0;
  const calls=[];
  const api=createProtocol({startService:async()=>{starts++;},fetcher:async(url,options={})=>{
    calls.push({path:url.pathname,method:options.method||'GET'});
    if(url.pathname==='/api/context')return jsonResponse(context);
    return jsonResponse({mode:'demo'});
  }});
  const first=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/state'}});
  assert.equal(first.structuredContent.ok,true);
  context={status:'different-service'};
  const second=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/actions',method:'POST',body:{action:'message'}}});
  assert.equal(second.structuredContent.ok,false);assert.match(second.structuredContent.error,/不是 Relay/);
  assert.deepEqual(calls.map(call=>call.path),['/api/context','/api/state','/api/context']);assert.equal(starts,0);
});

test('offline startup uses only the verified loopback destination and waits for its identity',async()=>{
  let online=false,starts=0,waited=0;
  const calls=[];
  const api=createProtocol({apiBase:'http://localhost:4329',sleep:async ms=>{waited+=ms;},startService:async({base})=>{
    starts++;assert.equal(base.hostname,'localhost');assert.equal(base.port,'4329');online=true;
  },fetcher:async(url,options={})=>{
    calls.push({path:url.pathname,method:options.method||'GET'});
    assert.equal(url.origin,'http://localhost:4329');
    if(url.pathname==='/api/context'){
      if(!online)throw new Error('PRIVATE_CONNECTION_ERROR');
      return jsonResponse(serviceContext());
    }
    assert.equal(url.pathname,'/api/state');return jsonResponse({mode:'demo'});
  }});
  const result=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/state'}});
  assert.equal(result.structuredContent.ok,true);assert.equal(starts,1);assert.equal(waited,500);
  assert.deepEqual(calls.map(call=>call.path),['/api/context','/api/context','/api/state']);
  for(const apiBase of ['https://localhost:4318','http://example.com:4318','http://user:pass@localhost:4318','http://127.0.0.1:4318/api']){
    assert.throws(()=>createProtocol({apiBase}),/本机 HTTP 服务地址/);
  }
});

test('concurrent requests share the initial slow probe and launch only one local service',async()=>{
  let rejectProbe;
  const probeGate=new Promise((resolve,reject)=>{rejectProbe=reject;});
  let contextCalls=0,starts=0,stateCalls=0,online=false;
  const api=createProtocol({sleep:async()=>{},startService:async()=>{starts++;online=true;},fetcher:async url=>{
    if(url.pathname==='/api/context'){
      contextCalls++;
      if(contextCalls===1)await probeGate;
      assert.equal(online,true);return jsonResponse(serviceContext());
    }
    assert.equal(url.pathname,'/api/state');stateCalls++;return jsonResponse({mode:'demo'});
  }});
  const request=()=>api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/state'}});
  const first=request(),second=request();
  assert.equal(contextCalls,1);assert.equal(starts,0);
  rejectProbe(new Error('PRIVATE_OFFLINE_ERROR'));
  const results=await Promise.all([first,second]);
  assert.equal(results.every(result=>result.structuredContent.ok),true);
  assert.equal(contextCalls,2);assert.equal(starts,1);assert.equal(stateCalls,2);
});

test('failed startup has a safe diagnostic and clears the shared attempt so a later request can retry',async()=>{
  let starts=0,online=false;
  const api=createProtocol({sleep:async()=>{},startService:async()=>{
    starts++;
    if(starts===1)throw new Error('PRIVATE_SPAWN_ERROR');
    online=true;
  },fetcher:async url=>{
    if(url.pathname==='/api/context'){
      if(!online)throw new Error('PRIVATE_FETCH_ERROR');
      return jsonResponse(serviceContext());
    }
    return jsonResponse({mode:'demo'});
  }});
  const request=()=>api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/state'}});
  const failed=await request();
  assert.equal(failed.isError,true);assert.match(failed.structuredContent.error,/无法启动/);
  assert.equal(JSON.stringify(failed).includes('PRIVATE_'),false);
  const retried=await request();
  assert.equal(retried.structuredContent.ok,true);assert.equal(starts,2);
});

test('startup polling is bounded and never forwards a task without a verified service',async()=>{
  let starts=0,probes=0,waited=0;
  const api=createProtocol({sleep:async ms=>{waited+=ms;},startService:async()=>{starts++;},fetcher:async url=>{
    assert.equal(url.pathname,'/api/context');probes++;throw new Error('PRIVATE_OFFLINE_ERROR');
  }});
  const result=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/actions',method:'POST',body:{action:'message'}}});
  assert.equal(result.isError,true);assert.match(result.structuredContent.error,/启动后未能就绪/);
  assert.equal(starts,1);assert.equal(probes,16);assert.equal(waited,7500);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

test('request failures after identity verification keep upstream details private',async()=>{
  const api=createProtocol({fetcher:async url=>{
    if(url.pathname==='/api/context')return jsonResponse(serviceContext());
    throw new Error('PRIVATE_UPSTREAM_CREDENTIAL');
  }});
  const result=await api.handle('tools/call',{name:'relay_request',arguments:{route:'/api/state'}});
  assert.equal(result.isError,true);assert.match(result.structuredContent.error,/无法连接/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

test('0.6.0 resource registration retains 0.5.3 and earlier aliases and uses current inline bundle bytes',async()=>{
  const api=createProtocol({fetcher:async()=>{throw new Error('resource must not make a service or model request')}});
  const resources=(await api.handle('resources/list')).resources;
  assert.deepEqual(resources.map(resource=>resource.uri),['ui://relay/v0.6.0/workspace','ui://relay/v0.6.0/panel']);
  for(const uri of ['ui://relay/v0.5.3/workspace','ui://relay/v0.5.3/panel','ui://relay/v0.5.2/workspace','ui://relay/v0.5.2/panel','ui://relay/v0.5.1/workspace','ui://relay/v0.5.1/panel','ui://relay/v0.5.0/workspace','ui://relay/v0.5.0/panel','ui://relay/v0.4.0/workspace','ui://relay/v0.4.0/panel']){
    const result=await api.handle('resources/read',{uri});
    assert.equal(result.contents[0].uri,uri);
    assert.ok(result.contents[0].text.includes('window.__RELAY_NATIVE__=true;'));
    if(uri.endsWith('/panel'))assert.ok(result.contents[0].text.includes("window.__RELAY_VIEW__='deepseek';"));
  }
});
test('native UI bundles code inline and avoids localhost iframes or external scripts',async()=>{
  const api=createProtocol({fetcher:async()=>{throw new Error('no network')}});
  const resource=await api.handle('resources/read',{uri:RESOURCE_URI});
  const html=resource.contents[0].text;
  const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  assert.ok(html.includes('window.__RELAY_NATIVE__=true'));
  assert.ok(!/<iframe\b/.test(markup));
  assert.ok(!/<script\b[^>]*\bsrc=/.test(markup));
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains,[]);
  const source=await readFile(new URL('./relay-native/dist/index.html',import.meta.url),'utf8');
  for(const match of source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/gi)){
    const javascript=await readFile(new URL('./relay-native/dist/'+match[1].replace(/^\//,''),import.meta.url),'utf8');
    assert.ok(html.includes(javascript.replace(/<\/script/gi,'<\\/script')),'packaged script must preserve the complete build output');
  }
});

function teamState(mode='live') {
  return {
    mode,collaborationMode:'independent',phase:'idle',leaderId:'leader',
    agents:[
      {id:'leader',name:'原生负责人',provider:'codex',modelId:'gpt-5.5',reasoningEffort:'high',status:'idle'},
      {id:'worker',name:'隐藏工作者',provider:'deepseek',modelId:'deepseek-v4-pro',reasoningEffort:'max',accessMode:'read-only',hidden:true,status:'idle'},
      {id:'other',name:'另一侧',provider:'codex',modelId:'gpt-5.4-mini',status:'idle'},
    ],
    chatSessions:{leader:{id:'chat-leader',status:'idle',providerSession:{id:'PRIVATE_NATIVE_ID'}},worker:{id:'chat-worker',status:'idle'},other:{id:'chat-other',status:'idle'}},
    messages:[
      {id:'leader-output',agentId:'leader',conversationId:'chat-leader',role:'assistant',kind:'message',status:'completed',text:'PRIVATE_LEADER_OUTPUT'},
      {id:'older-worker',agentId:'worker',conversationId:'chat-worker',role:'assistant',kind:'message',status:'completed',text:'OLDER_WORKER_OUTPUT'},
      {id:'other-tool',agentId:'other',conversationId:'chat-other',role:'assistant',kind:'tool',text:'PRIVATE_TOOL_LOG'},
    ],
    goal:'PRIVATE_GLOBAL_GOAL',settings:{secret:'PRIVATE_SETTINGS',maxParallelReaders:3},chatArchives:{old:{text:'PRIVATE_ARCHIVE'}},
    executionSummary:{readers:2,writers:0,retiringReaders:1,retiringWriters:0,secret:'PRIVATE_EXECUTION'},
    usage:{supervisorCalls:0,workerCalls:0,inputTokens:0,outputTokens:0,providerCalls:{codex:0,deepseek:0},autoProviderCalls:{codex:0,deepseek:0},autoSupervisorCalls:0,autoWorkerCalls:0,secret:'PRIVATE_USAGE'},
  };
}

function teamFixture({initial=teamState(),onPoll,onPost,contextDelayMs=0,postDelayMs=0}={}) {
  let current=structuredClone(initial),clock=0,posts=0,reads=0;
  const calls=[];
  const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(data)});
  const api=createProtocol({now:()=>clock,sleep:async ms=>{clock+=ms;},pollIntervalMs:500,fetcher:async(url,options={})=>{
    const method=options.method||'GET';
    const body=options.body?JSON.parse(options.body):undefined;
    calls.push({path:url.pathname,method,body});
    assert.equal(url.hostname,'127.0.0.1');
    if(url.pathname==='/api/context'){clock+=contextDelayMs;return response(serviceContext({workspace:'C:\\work\\shared',private:'PRIVATE_CONTEXT'}));}
    if(url.pathname==='/api/state'){
      reads++;
      if(onPoll&&posts) {
        const custom=onPoll(current,{reads,posts,clock});
        if(custom)return custom;
      }
      return response(current);
    }
    if(url.pathname==='/api/actions'&&method==='POST'){
      posts++;
      clock+=postDelayMs;
      assert.equal(body.action,'message','must not dispatch a planner/reviewer or alter configuration');
      assert.equal(body.agentId,'worker','must call exactly the chosen nonleader worker');
      assert.deepEqual(Object.keys(body).sort(),['action','agentId','expectedConversationId','expectedLeaderId','text']);
      assert.equal(body.expectedLeaderId,'leader');
      assert.equal(body.expectedConversationId,'chat-worker');
      const custom=onPost?.(current,body);
      if(custom)return custom;
      current.agents.find(agent=>agent.id==='worker').status='running';
      current.chatSessions.worker.status='running';
      current.messages.push({id:'submitted-user',agentId:'worker',conversationId:'chat-worker',role:'user',kind:'message',text:body.text});
      current.messages.push({id:'submitted-answer',agentId:'worker',conversationId:'chat-worker',role:'assistant',kind:'message',status:'streaming',text:''});
      if(current.mode==='live') {current.usage.workerCalls++;current.usage.providerCalls.deepseek++;}
      return response(current);
    }
    assert.fail('tool requested a route outside the fixed team API');
  }});
  return {api,calls,get state(){return current},set state(value){current=value},get clock(){return clock},get posts(){return posts}};
}

function finishWorker(state,output='PUBLIC_WORKER_RESULT') {
  const reply=state.messages.find(message=>message.id==='submitted-answer');
  reply.status='completed';reply.text=output;
  state.chatSessions.worker.status='idle';
  state.agents.find(agent=>agent.id==='worker').status='idle';
}
const delegation={agentId:'worker',task:'整理实际产物并报告检查',criteria:['产物位置明确','检查结果可验证']};

test('native delegation tools are model-visible at 0.6.0 without exposing arbitrary routes',async()=>{
  const fixture=teamFixture();
  const init=await fixture.api.handle('initialize');
  assert.equal(init.serverInfo.version,'0.6.0');
  const status=tools.find(tool=>tool.name==='agent_team_status');
  const delegate=tools.find(tool=>tool.name==='delegate_agent_task');
  assert.equal(status.annotations.readOnlyHint,true);
  assert.equal(delegate.annotations.readOnlyHint,false);
  assert.equal(delegate.annotations.idempotentHint,false);
  assert.equal(status.inputSchema.properties.waitSeconds.maximum,45);
  assert.equal(delegate.inputSchema.properties.waitSeconds.maximum,45);
  assert.equal(status._meta?.['openai/visibility'],undefined);
  assert.equal(delegate._meta?.['openai/visibility'],undefined);
  assert.equal('route' in delegate.inputSchema.properties,false);
  assert.equal('url' in status.inputSchema.properties,false);
});

test('team status returns only public team configuration and usage, without conversations or secrets',async()=>{
  const fixture=teamFixture();
  const result=await fixture.api.handle('tools/call',{name:'agent_team_status',arguments:{}});
  assert.equal(result.structuredContent.team.length,3);
  assert.equal(result.structuredContent.workspace,'C:\\work\\shared');
  const worker=result.structuredContent.team.find(agent=>agent.id==='worker');
  assert.equal(worker.model,'deepseek-v4-pro');assert.equal(worker.reasoningEffort,'max');assert.equal(worker.hidden,true);
  assert.equal(worker.accessMode,'read-only');
  assert.deepEqual(result.structuredContent.executionSummary,{readers:2,writers:0,retiringReaders:1,retiringWriters:0});
  assert.deepEqual(result.structuredContent.limits,{maxParallelReaders:3});
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  assert.equal(JSON.stringify(result).includes('OLDER_WORKER_OUTPUT'),false);
  assert.equal(fixture.posts,0);
});

test('native supervisor delegates exactly one worker message and receives only its matching unreviewed result',async()=>{
  const fixture=teamFixture({onPoll:state=>finishWorker(state)});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:5}});
  const data=result.structuredContent;
  assert.equal(data.status,'completed');assert.equal(data.output,'PUBLIC_WORKER_RESULT');
  assert.equal(data.sessionId,'chat-worker');assert.equal(data.messageId,'submitted-answer');
  assert.equal(data.reviewStatus,'unreviewed');assert.deepEqual(data.criteria,delegation.criteria);
  assert.equal(data.delegationAccounting,'manual_chat');
  assert.equal(data.usage.providerCalls.deepseek,1);assert.equal(data.usage.providerCalls.codex,0);
  assert.equal(data.usage.autoWorkerCalls,0);assert.equal(fixture.posts,1);
  assert.equal(fixture.state.mode,'live');assert.equal(fixture.state.collaborationMode,'independent');
  assert.equal(fixture.state.settings.secret,'PRIVATE_SETTINGS');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  assert.ok(fixture.calls.every(call=>['/api/context','/api/state','/api/actions'].includes(call.path)));
  const post=fixture.calls.find(call=>call.method==='POST');
  assert.ok(post.body.text.includes(delegation.criteria[0]));assert.ok(post.body.text.length<=12000);
});

test('45-second wait returns a running reference and status can continue without a second delegation',async()=>{
  const fixture=teamFixture();
  const waiting=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:45}});
  assert.equal(waiting.structuredContent.status,'running');assert.equal(fixture.clock,45000);assert.equal(fixture.posts,1);
  finishWorker(fixture.state,'LATER_OUTPUT');
  const result=await fixture.api.handle('tools/call',{name:'agent_team_status',arguments:{agentId:'worker',sessionId:waiting.structuredContent.sessionId,messageId:waiting.structuredContent.messageId,waitSeconds:2}});
  assert.equal(result.structuredContent.chat.status,'completed');assert.equal(result.structuredContent.chat.output,'LATER_OUTPUT');
  assert.equal(result.structuredContent.chat.reviewStatus,'unreviewed');assert.equal(fixture.posts,1);
});

test('changed worker session is rejected rather than returning its unrelated new output',async()=>{
  const fixture=teamFixture({onPoll:state=>{
    state.chatSessions.worker={id:'new-chat',status:'idle'};
    state.messages.push({id:'new-answer',agentId:'worker',conversationId:'new-chat',role:'assistant',kind:'message',status:'completed',text:'PRIVATE_NEW_CHAT_OUTPUT'});
  }});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:5}});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'changed');
  assert.equal(result.structuredContent.sessionId,'chat-worker');
  assert.equal(JSON.stringify(result).includes('PRIVATE_NEW_CHAT_OUTPUT'),false);
});

test('same conversation with a newer reply cannot replace the captured worker message',async()=>{
  const fixture=teamFixture({onPoll:state=>{
    finishWorker(state,'ORIGINAL_MATCHED_RESULT');
    state.messages.push({id:'newer-answer',agentId:'worker',conversationId:'chat-worker',role:'assistant',kind:'message',status:'completed',text:'UNRELATED_NEWER_RESULT'});
  }});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:5}});
  assert.equal(result.structuredContent.output,'ORIGINAL_MATCHED_RESULT');
  assert.equal(result.structuredContent.messageId,'submitted-answer');
  assert.equal(JSON.stringify(result).includes('UNRELATED_NEWER_RESULT'),false);
});

test('unknown, leader, busy and running-cooperation targets are rejected without sending a message',async()=>{
  for(const scenario of ['unknown','leader','busy','workflow','demo-workflow']){
    const initial=teamState(scenario==='demo-workflow'?'demo':'live');
    const agentId=scenario==='unknown'?'missing':scenario==='leader'?'leader':'worker';
    if(scenario==='busy')initial.chatSessions.worker.status='running';
    if(scenario.includes('workflow'))initial.phase='running';
    const fixture=teamFixture({initial});
    const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,agentId}});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'rejected');assert.equal(fixture.posts,0);
  }
});

test('backend mutual-exclusion refusal does not retry or bypass the message action',async()=>{
  const fixture=teamFixture({onPost:()=>({ok:false,status:409,json:async()=>({error:'后端发现工作者忙碌'})})});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:delegation});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'rejected');
  assert.match(result.structuredContent.error,/忙碌/);assert.equal(fixture.posts,1);
  assert.equal(fixture.calls.filter(call=>call.method==='POST').length,1);
});

test('delegation supplies atomic leader/session guards and backend races refuse before worker inference',async()=>{
  for(const changed of ['leader','conversation']){
    const fixture=teamFixture({onPost:(state,body)=>{
      if(changed==='leader')state.leaderId='worker';
      else state.chatSessions.worker.id='different-conversation';
      if(body.expectedLeaderId!==state.leaderId||body.expectedConversationId!==state.chatSessions.worker.id){
        return {ok:false,status:409,json:async()=>({error:'原子检查拒绝：负责人或会话发生变化'})};
      }
      assert.fail('race must be rejected before provider execution');
    }});
    const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:0}});
    assert.equal(result.structuredContent.status,'rejected');assert.equal(result.isError,true);
    assert.equal(fixture.state.usage.providerCalls.deepseek,0);assert.equal(fixture.state.usage.providerCalls.codex,0);
    assert.equal(fixture.posts,1);assert.equal(fixture.calls.filter(call=>call.method==='POST').length,1);
  }
});

test('delegate and reference-based status default to bounded waits while explicit zero stays immediate',async()=>{
  const fixture=teamFixture();
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:delegation});
  assert.equal(fixture.clock,30000);assert.equal(result.structuredContent.status,'running');
  const reference={agentId:'worker',sessionId:'chat-worker',messageId:'submitted-answer'};
  const status=await fixture.api.handle('tools/call',{name:'agent_team_status',arguments:reference});
  assert.equal(fixture.clock,60000);assert.equal(status.structuredContent.chat.status,'running');assert.equal(fixture.posts,1);
  await fixture.api.handle('tools/call',{name:'agent_team_status',arguments:{...reference,waitSeconds:0}});
  assert.equal(fixture.clock,60000);
  const immediate=teamFixture();
  await immediate.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:0}});
  assert.equal(immediate.clock,0);assert.equal(immediate.posts,1);
  const overview=teamFixture();
  await overview.api.handle('tools/call',{name:'agent_team_status',arguments:{}});
  assert.equal(overview.clock,0);assert.equal(overview.posts,0);
});

test('slow dispatch reduces polling so the entire model tool finishes within its 80-second deadline',async()=>{
  const fixture=teamFixture({contextDelayMs:10000,postDelayMs:40000});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:45}});
  assert.equal(result.structuredContent.status,'running');assert.equal(fixture.clock,80000);
  assert.equal(result.structuredContent.sessionId,'chat-worker');assert.equal(fixture.posts,1);
});

test('demo delegation stays explicitly simulated and never pretends to be a real worker execution',async()=>{
  const fixture=teamFixture({initial:teamState('demo'),onPoll:state=>finishWorker(state,'【演示】模拟结果，没有执行命令')});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:2}});
  assert.equal(result.structuredContent.mode,'demo');assert.match(result.structuredContent.notice,/模拟/);
  assert.match(result.structuredContent.output,/演示/);assert.equal(result.structuredContent.reviewStatus,'unreviewed');
  assert.equal(result.structuredContent.usage.providerCalls.deepseek,0);
  assert.equal(fixture.calls.some(call=>call.body?.action==='mode'||call.body?.action==='start'||call.body?.action==='review'),false);
});

test('worker failure and cancellation remain unsuccessful public results',async()=>{
  for(const status of ['error','cancelled']){
    const fixture=teamFixture({onPoll:state=>{
      const reply=state.messages.find(message=>message.id==='submitted-answer');reply.status=status;reply.text='partial only';
      state.chatSessions.worker.status='idle';state.chatSessions.worker.lastError=status==='error'?'实际执行失败':undefined;
    }});
    const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:2}});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.status,status);assert.ok(result.structuredContent.error);
    assert.equal(result.structuredContent.reviewStatus,'unreviewed');
  }
});

test('post acknowledgement without a matching new user/reply cannot reuse old worker output',async()=>{
  const fixture=teamFixture({onPost:state=>({ok:true,status:200,json:async()=>state})});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:delegation});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'unknown');
  assert.equal(JSON.stringify(result).includes('OLDER_WORKER_OUTPUT'),false);assert.equal(fixture.posts,1);
});

test('mode change during wait is reported without confusing simulation with a real result',async()=>{
  const fixture=teamFixture({onPoll:state=>{state.mode='demo';finishWorker(state,'UNRELATED_SIMULATION');}});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:2}});
  assert.equal(result.structuredContent.status,'changed');assert.equal(result.isError,true);
  assert.equal(JSON.stringify(result).includes('UNRELATED_SIMULATION'),false);
});

test('failed polling preserves the task reference without resubmitting or claiming completion',async()=>{
  const fixture=teamFixture({onPoll:()=>({ok:false,status:503,json:async()=>({error:'暂时不能查询'})})});
  const result=await fixture.api.handle('tools/call',{name:'delegate_agent_task',arguments:{...delegation,waitSeconds:2}});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'unknown');
  assert.equal(result.structuredContent.messageId,'submitted-answer');assert.equal(fixture.posts,1);
});

test('team tools validate wait bounds, input scope and combined prompt length before any request',async()=>{
  const api=createProtocol({fetcher:()=>assert.fail('invalid input must not reach the service')});
  for(const arguments_ of [
    {...delegation,waitSeconds:46},{...delegation,waitSeconds:-1},{...delegation,waitSeconds:1.5},
    {...delegation,criteria:[]},{...delegation,criteria:[' ']},
    {...delegation,task:'x'.repeat(11000),criteria:['y'.repeat(1000)]},
    {...delegation,url:'https://example.test'},
  ])await assert.rejects(api.handle('tools/call',{name:'delegate_agent_task',arguments:arguments_}));
  await assert.rejects(api.handle('tools/call',{name:'agent_team_status',arguments:{waitSeconds:1}}));
  await assert.rejects(api.handle('tools/call',{name:'agent_team_status',arguments:{agentId:'worker',messageId:'reply'}}));
  await assert.rejects(api.handle('tools/call',{name:'agent_team_status',arguments:{route:'/api/actions'}}));
});
