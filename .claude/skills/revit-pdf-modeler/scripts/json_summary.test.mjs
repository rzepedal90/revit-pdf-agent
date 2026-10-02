// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize} from './json_summary.mjs';
test('bounds rows, strings and nested arrays',()=>{
 const value={dimensions:Array.from({length:100},()=>({source_key:'x'.repeat(1000),refs:Array(1000).fill(1)}))};
 const result=summarize(value,{path:'dimensions',limit:2,fields:['source_key','refs']});
 assert.equal(result.count,100);assert.equal(result.sample.length,2);
 assert.equal(result.sample[0].source_key.length,200);assert.equal(result.sample[0].refs.count,1000);
});
test('invalid path or unbounded limit fails',()=>{
 assert.throws(()=>summarize({},{path:'dimensions'}),/Missing/);
 assert.throws(()=>summarize([],{limit:100}),/Limit/);
});
