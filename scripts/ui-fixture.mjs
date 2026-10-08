// Local UI verification only: isolated in-memory demo, no login or model calls.
import { Orchestrator } from '../server/engine.mjs';
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
const engine = new Orchestrator({providers:fixtureProviders,demoDelayMs:1000});
const port=Number(process.env.RELAY_FIXTURE_PORT || 4319);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid fixture port');
const app = createAppServer({engine,port,modelCatalogProvider:fixtureProviders});
app.server.listen(port,'127.0.0.1',()=>process.stdout.write(`Isolated demo UI: http://127.0.0.1:${port}\n`));
app.server.on('error', error => {process.stderr.write(error.message+'\n'); process.exitCode=1;});
process.on('SIGINT',()=>app.close());
process.on('SIGTERM',()=>app.close());
