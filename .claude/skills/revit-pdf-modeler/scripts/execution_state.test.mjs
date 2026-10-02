// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// NOTE (our MCP): tests THEIR `callBatch`/`get_element_info` contract. Pending an OUR-MCP adapter.
import test from 'node:test';import assert from 'node:assert/strict';
import {bindContract,reconcileLedger,identityIndex} from './execution_state.mjs';
import {hash} from './execution_runner.mjs';
test('contract checks approved hashes, ledger and source intent',()=>{
 const row={source_key:'a',status:'resolved',execution_action:'create'};
 const manifest={mode:'EXECUTE',manifest_frozen:true,execution_policy:{commit_authorized:true},element_manifest:[row]};
 const recipes=[{source_key:'a',intent:row,steps:[]}];const ledger={manifestHash:hash(manifest),recipesHash:hash(recipes)};
 const input={manifest,recipes,ledger,expectedManifestHash:hash(manifest),expectedRecipesHash:hash(recipes)};
 assert.doesNotThrow(()=>bindContract(input));assert.throws(()=>bindContract({...input,ledger:{}}),/different/);
 assert.throws(()=>bindContract({...input,expectedRecipesHash:'old'}),/changed/);
});
test('restart verifies every previously verified row as well as pending rows',async()=>{
 const recipes=['a','b'].map(source_key=>({source_key,steps:[]}));
 const ledger={elements:{a:{id:1,uniqueId:'u1',state:'verified',recipeHash:hash([])},b:{id:2,state:'pending',recipeHash:hash([])}}};
 const seen=[],saved=[];
 const r=await reconcileLedger({recipes,ledger,callBatch:async steps=>({ok:true,results:steps.map(s=>({ok:true,data:{id:s.params.id,uniqueId:'u'+s.params.id}}))}),
  verify:async e=>seen.push(e.source_key),resolvePending:async(k,v)=>saved.push([k,v])});
 assert.deepEqual(seen,['a','b']);assert.equal(r.reconciled,1);assert.equal(saved[0][1].uniqueId,'u2');
});
test('incremental index rejects unknown external edits and duplicate deltas',()=>{
 const index=identityIndex({snapshot:[{uniqueId:'old',source_key:'a'}],revision:'r1'});
 assert.equal(index.lookup('a','r1').state,'exact');assert.throws(()=>index.lookup('a','r2'),/changed/);
 index.checkpoint({uniqueId:'new',source_key:'b'},{beforeRevision:'r1',afterRevision:'r2'});
 assert.equal(index.lookup('b','r2').state,'exact');assert.throws(()=>index.checkpoint({uniqueId:'new'},{beforeRevision:'r2',afterRevision:'r3'}));
});
