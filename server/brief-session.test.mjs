import test from 'node:test';
import assert from 'node:assert/strict';
import {Orchestrator,createInitialState} from './engine.mjs';

const fields={objective:'fixture objective',deliverables:'fixture output',acceptance:'fixture evidence',constraints:'',questions:''};
const noInference={getCapabilities:()=>assert.fail('saving must not check models'),runAgent:()=>assert.fail('saving must not invoke models')};

test('a stale collaboration identity cannot overwrite a different session with the same draft revision',async t=>{
  const old=createInitialState();
  const engine=new Orchestrator({initialState:createInitialState(),providers:noInference});t.after(()=>engine.close());
  const before=engine.getState();assert.notEqual(old.id,before.id);
  await assert.rejects(engine.action({action:'saveGoalBrief',expectedStateId:old.id,expectedRevision:0,brief:fields}),e=>e.status===409);
  assert.deepEqual(engine.getState(),before);
  const saved=await engine.action({action:'saveGoalBrief',expectedStateId:before.id,expectedRevision:0,brief:fields});
  assert.equal(saved.goalDraft.revision,1);assert.equal(saved.goalDraft.objective,fields.objective);
  assert.equal(saved.goal,before.goal);assert.deepEqual(saved.tasks,before.tasks);assert.deepEqual(saved.usage,before.usage);
  assert.equal(saved.mode,before.mode);assert.equal(saved.collaborationMode,before.collaborationMode);assert.equal(engine.runs.size,0);
});

test('draft identity guard rejects invalid values while legacy UI saving still works',async t=>{
  const engine=new Orchestrator({providers:noInference});t.after(()=>engine.close());const before=engine.getState();
  for(const value of ['',null,1,'x'.repeat(257)]) {
    await assert.rejects(engine.action({action:'saveGoalBrief',expectedStateId:value,expectedRevision:0,brief:fields}),e=>e.status===400);
    assert.deepEqual(engine.getState(),before);
  }
  const saved=await engine.action({action:'saveGoalBrief',expectedRevision:0,brief:fields});assert.equal(saved.goalDraft.revision,1);
});
