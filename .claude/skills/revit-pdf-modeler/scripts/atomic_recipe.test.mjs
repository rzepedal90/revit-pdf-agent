// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// NOTE (our MCP): exercises THEIR atomic recipe shape (`update_where` expectedCount:1, `callBatch`). Pending an OUR-MCP adapter.
import test from 'node:test';import assert from 'node:assert/strict';import {runPaced} from './execution_runner.mjs';
const recipe={source_key:'a',steps:[{command:'place_family_instance',params:{}},
 {command:'update_where',params:{category:'OST_StructuralColumns',where:[{parameter:'Comments',value:'a'}],atomic:true,expectedCount:1,set:{parameter:'Top Offset',value:0,scope:'instance'}}},
 {command:'query_where',params:{category:'OST_StructuralColumns',where:[{parameter:'Comments',value:'a'}]}}]};
const args={elements:[recipe],commit:true,authorized:true,guard:async()=>{},validate:async()=>{},match:async()=>({state:'missing'}),verify:async()=>{},refresh:async()=>{},invalidateCache:async()=>{},writeEvidence:async()=>{}};
test('required settings remain in identical atomic dry/commit batch',async()=>{
 const calls=[];const r=await runPaced({...args,callBatch:async(s,_,dry)=>{calls.push(s);return {ok:true,committed:!dry,results:[{ok:true,data:{id:1}},{ok:true,data:{matchedCount:1,targetCount:1,failed:0}},{ok:true,data:{count:1}}]};}});
 assert.equal(r.created,1);assert.deepEqual(calls[0],calls[1]);
});
test('unscoped updates, second creation, unsafe scope and interval reject before mutation',async()=>{
 for(const change of [e=>e.steps.push({command:'create_wall'}),e=>e.steps[1].params.expectedCount=2,e=>e.steps[1].params.set.scope='type',e=>e.steps[1].params.where=[]]){
  const e=structuredClone(recipe);change(e);await assert.rejects(runPaced({...args,elements:[e],callBatch:async()=>{throw Error('must not execute');}}));
 }
 await assert.rejects(runPaced({...args,intervalMs:199,callBatch:async()=>{}}),/200/);
});
test('wrong matched count in preview blocks commit',async()=>{
 let calls=0;await assert.rejects(runPaced({...args,callBatch:async()=>{calls++;return {ok:true,committed:false,results:[{ok:true},{ok:true,data:{matchedCount:2,targetCount:2,failed:0}},{ok:true,data:{count:2}}]};}}),/Dry-run/);
 assert.equal(calls,1);
});
