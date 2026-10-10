// Local UI verification only: isolated in-memory demo, no login or model calls.
import { Orchestrator, createInitialState } from '../server/engine.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import { createAppServer } from '../server/index.mjs';

const catalog = provider => ({
  available: true, catalogOnly: true, detail: '界面验收用模拟目录，不调用模型',
  models: [{ id: `demo-${provider}`, label: `${provider === 'codex' ? 'Codex' : 'DeepSeek'} · 模拟模型`, isDefault: true,
    reasoningEffortSupported: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: (provider === 'codex' ? ['low', 'medium', 'high'] : ['off', 'low', 'high', 'max']).map(reasoningEffort => ({ reasoningEffort })),
  }],
});
const fixtureProviders = {
  getModels: async ({ provider }) => catalog(provider),
  getCapabilities: async () => ({codex:{available:false,detail:'界面验收用演示环境'},harness:{available:false,detail:'界面验收用演示环境'},liveReady:false}),
  runAgent: async () => { throw new Error('UI fixture cannot invoke models'); },
};
const reviewErrors = Number(process.env.RELAY_FIXTURE_REVIEW_ERRORS || 0);
if (!Number.isInteger(reviewErrors) || reviewErrors < 0 || reviewErrors > 10) throw new Error('Invalid fixture review errors');
const initialState = createInitialState();
if (reviewErrors) {
  initialState.collaborationMode = 'cooperative';
  initialState.goal = '【演示】核查回复无效时，保留同一交付并只重新核查。';
  initialState.tasks = [{id:'demo-review-retained',title:'核查演示交付',description:'仅用于隔离验收，模拟交付与核查，不生成文件或调用真实模型。',
    agentId:'deepseek-builder',status:'queued',attempt:0,dependsOn:[],criteria:[{id:'demo-evidence',text:'核查原交付的演示证据',status:'pending'}]}];
  initialState.messages = [];
}
const engine = new Orchestrator({providers:fixtureProviders,demoDelayMs:1000,workspace:'C:/Projects/hetero-agent-demo',initialState});
if (reviewErrors) {
  const originalReview = engine._demoReview.bind(engine);
  let remaining = reviewErrors;
  engine._demoReview = async (task, signal) => {
    if (remaining > 0) {
      await delay(700,undefined,{signal}); remaining -= 1;
      return {text:'【演示】故意返回非 JSON 核查回复，验证交付保留。'};
    }
    return originalReview(task,signal);
  };
  await engine.action({action:'start'});
}
// Optional latency for reproducing close/reopen races in the isolated UI.
const actionDelay = Number(process.env.RELAY_FIXTURE_ACTION_DELAY_MS || 0);
if (!Number.isInteger(actionDelay) || actionDelay < 0 || actionDelay > 10000) throw new Error('Invalid fixture action delay');
const action = engine.action.bind(engine);
engine.action = async payload => {
  if (actionDelay && ['saveGoalBrief', 'confirmGoalBrief'].includes(payload?.action)) await new Promise(resolve => setTimeout(resolve, actionDelay));
  return action(payload);
};
const port=Number(process.env.RELAY_FIXTURE_PORT || 4319);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid fixture port');
const app = createAppServer({engine,port,modelCatalogProvider:fixtureProviders});
app.server.listen(port,'127.0.0.1',()=>process.stdout.write(`Isolated demo UI: http://127.0.0.1:${port}\n`));
app.server.on('error', error => {process.stderr.write(error.message+'\n'); process.exitCode=1;});
process.on('SIGINT',()=>app.close());
process.on('SIGTERM',()=>app.close());
