// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// NOTE (our MCP): runPaced and readBatched assume THEIR addin API: `callBatch` (batched command execution with dry-run),
// `get_element_info`, `update_where`/`query_where` atomic steps and their create commands (place_family_instance, create_beam...).
// They are PENDING an adapter onto OUR MCP tools (batch with dryRun, get_elements_info, query_where, set_parameter). Logic is unchanged.
import {createHash} from 'node:crypto';
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
export const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
export async function readBatched(ids,callBatch,size=100){
 if(!Number.isInteger(size)||size<1||size>100)throw Error('Invalid read batch size');
 const result=[];for(let i=0;i<ids.length;i+=size){const page=ids.slice(i,i+size);const r=await callBatch(page.map(id=>({command:'get_element_info',params:{id}})),true,false);const rows=r.results??r.data?.results;if(!r.ok||r.hadFailures||rows?.length!==page.length||rows.some((x,j)=>!x.ok||x.data?.id!==page[j]))throw Error('Incomplete or reordered readback');result.push(...rows.map(x=>x.data));}return result;
}
/** One element per committed checkpoint. This deliberately is NOT whole-stage atomic. */
export async function runPaced({elements,commit=false,authorized=false,intervalMs=200,guard,validate,match,verify,refresh,invalidateCache,callBatch,writeEvidence,onDecision=async()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),signal}){
 if(commit&&!authorized)throw Error('Frozen-manifest authorization required');
 if(!Number.isFinite(intervalMs)||intervalMs<200)throw Error('Minimum interval is 200 ms');
 for(const f of [guard,validate,match,verify,refresh,invalidateCache,callBatch,writeEvidence])if(typeof f!=='function')throw Error('Validation, identity, QA, refresh and evidence callbacks required');
 const rows=structuredClone(elements),keys=new Set();
 const create=new Set(['create_grid','place_family_instance','create_beam','create_wall','create_aligned_dimension']);
 for(const e of rows){
  if(!e.source_key||keys.has(e.source_key)||!e.steps?.length||!create.has(e.steps[0].command)||/rebar|reinforcement/i.test(JSON.stringify(e.steps)))throw Error('One approved element creation per unique source key required');
  for(const step of e.steps.slice(1)){
   const p=step.params;
   if(!['update_where','query_where'].includes(step.command)||!p?.category||!Array.isArray(p.where)||!p.where.length)throw Error('Unsupported or unscoped atomic recipe step');
   const source=p.where.some(w=>w.parameter==='Comments'&&w.value===e.source_key&&(w.operator===undefined||w.operator==='equals'));
   const tag=step.command==='update_where'&&p.set?.parameter==='Comments'&&p.set.value===e.source_key&&
    p.where.some(w=>w.parameter==='Comments'&&w.operator==='is_empty')&&p.where.some(w=>w.parameter==='Type Name'&&typeof w.value==='string');
   if(!source&&!tag)throw Error('Atomic recipe must select the exact source key or uniquely tag the new type instance');
   if(step.command==='update_where'&&(p.atomic!==true||p.expectedCount!==1||p.set?.scope!=='instance'))throw Error('Atomic update requires expectedCount:1 and instance scope');
  }
  keys.add(e.source_key);await validate(e);
 }
 const passed=(response,e,dry)=>{
  const r=response.data?.results?{...response,...response.data}:response;
  return r.ok&&!r.hadFailures&&r.committed===!dry&&r.results?.length===e.steps.length&&r.results.every((row,i)=>
   row.ok&&(e.steps[i].command!=='update_where'||(row.data?.matchedCount===1&&row.data?.targetCount===1&&row.data?.failed===0))&&
   (e.steps[i].command!=='query_where'||row.data?.count===1));
 };
 const result={created:0,skipped:0,previewed:0,checkpoints:[]};let lastCreated=false;
 for(const e of rows){
  if(signal?.aborted)throw Error('Interrupted; reconcile recorded checkpoints');
  if(lastCreated)await sleep(intervalMs);lastCreated=false;
  await guard();const existing=await match(e);
  if(existing?.state==='exact'){await verify(e,existing);result.skipped++;continue;}
  if(existing?.state!=='missing')throw Error('Ambiguous or conflicting identity');
  await onDecision({source_key:e.source_key,decision:e.decision??e.evidence,command:e.steps[0].command});
  const digest=hash(e.steps);
  await writeEvidence({phase:'planned',source_key:e.source_key,hash:digest,payload:e.steps});
  const dry=await callBatch(structuredClone(e.steps),true,true);await invalidateCache();
  await writeEvidence({phase:'dry',source_key:e.source_key,hash:digest,response:dry});
  if(!passed(dry,e,true))throw Error('Dry-run failed; no commit');
  result.previewed++;
  if(!commit)continue;
  await guard();if(signal?.aborted)throw Error('Interrupted before commit');
  if((await match(e))?.state!=='missing'||hash(e.steps)!==digest)throw Error('Identity or payload changed');
  await writeEvidence({phase:'commit_intent',source_key:e.source_key,hash:digest,payload:e.steps});
  const response=await callBatch(structuredClone(e.steps),true,false);await invalidateCache();
  await writeEvidence({phase:'commit',source_key:e.source_key,hash:digest,response});
  if(!passed(response,e,false))throw Error('Commit uncertain/failed; reconcile before any retry');
  await verify(e,response);await refresh();
  result.created++;result.checkpoints.push(e.source_key);lastCreated=true;
 }
 return result;
}
