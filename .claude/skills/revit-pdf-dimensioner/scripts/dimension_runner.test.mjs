// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// NOTE (our MCP): tests THEIR dimension API contract. Dimension execution is NOT supported in our MCP yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {payloadHash, referenceCache, runBatches} from './dimension_runner.mjs';
const step = key => ({command:'create_aligned_dimension',params:{sourceKey:key,canonicalSignature:key,
  dimensionTypeUniqueId:'type',viewId:1,expectedValues:[1],tolerance:.001,units:'meters',line:{start:{x:0,y:0,z:0},end:{x:1,y:0,z:0}},
  references:[{selector:'stable',elementUniqueId:'a',stableRepresentation:'a:1'},
    {selector:'stable',elementUniqueId:'b',stableRepresentation:'b:1'}]}});
const success = steps => ({ok:true,committed:true,results:steps.map(()=>({ok:true}))});
test('canonical hashes ignore object key ordering but preserve array order',()=>{
  assert.equal(payloadHash({b:1,a:2}),payloadHash({a:2,b:1}));
  assert.notEqual(payloadHash([1,2]),payloadHash([2,1]));
});
test('reference selectors deduplicate per run but never across views',async()=>{
  let calls=0;
  const resolve=referenceCache(async(_,p)=>{calls++;return {ok:true,data:{references:p.references.map(()=>({status:'resolved',stableRepresentation:'a'}))}};});
  assert.equal((await resolve({viewId:1,references:[{a:1},{a:1}]})).length,2);
  await resolve({viewId:1,references:[{a:1}]}); assert.equal(calls,1);
  await resolve({viewId:2,references:[{a:1}]}); assert.equal(calls,2);
});
test('commit has identical dry-run payload and compact summary',async()=>{
  const calls=[],evidence=[];
  const result=await runBatches({steps:[step('a'),step('b')],commit:true,authorized:true,
    guard:async()=>{},writeEvidence:async e=>evidence.push(e),callRevitBatch:async(s,stop,dry)=>{calls.push({s,stop,dry});return success(s);}});
  assert.deepEqual(calls[0].s,calls[1].s); assert.equal(calls[0].dry,true);assert.equal(calls[1].dry,false);
  assert.equal(result.committedSteps,2);assert.equal(evidence.length,2);
});
test('failed dry-run never commits',async()=>{
  let calls=0;
  await assert.rejects(runBatches({steps:[step('a')],commit:true,authorized:true,guard:async()=>{},
    writeEvidence:async()=>{},callRevitBatch:async()=>{calls++;return {ok:false};}}),/Dry-run blocked/);
  assert.equal(calls,1);
});
test('authorization, guard, duplicate identities and evidence failures stop execution',async()=>{
  const base={steps:[step('a')],guard:async()=>{},writeEvidence:async()=>{},callRevitBatch:async s=>success(s)};
  await assert.rejects(runBatches({...base,commit:true}),/authorization/);
  await assert.rejects(runBatches({...base,guard:null}),/Guard/);
  await assert.rejects(runBatches({...base,steps:[step('a'),step('a')]}),/Duplicate/);
  let committed=false;
  await assert.rejects(runBatches({...base,commit:true,authorized:true,writeEvidence:async()=>{throw Error('disk');},
    callRevitBatch:async(s,_,dry)=>{if(!dry)committed=true;return success(s);}}),/disk/);
  assert.equal(committed,false);
});
