// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// NOTE (our MCP): reconcileLedger uses readBatched (THEIR `callBatch` + `get_element_info`). bindContract/identityIndex are pure.
// Pending an adapter onto OUR MCP (batch, get_elements_info).
/** File-backed contracts and restart reconciliation; independent live verification is mandatory. */
import {hash,readBatched} from './execution_runner.mjs';

export function bindContract({manifest,recipes,ledger,expectedManifestHash,expectedRecipesHash}) {
 if(!manifest.manifest_frozen||manifest.mode!=='EXECUTE'||!manifest.execution_policy?.commit_authorized)
  throw Error('Frozen authorized EXECUTE manifest required');
 const manifestHash=hash(manifest),recipesHash=hash(recipes);
 if(manifestHash!==expectedManifestHash||recipesHash!==expectedRecipesHash)throw Error('Approved manifest/recipe contract changed');
 if(ledger.manifestHash!==manifestHash||ledger.recipesHash!==recipesHash)throw Error('Ledger belongs to a different contract');
 const intent=new Map((manifest.element_manifest??manifest.dimensions??[]).map(e=>[e.source_key,e]));
 const keys=new Set();
 for(const e of recipes){const row=intent.get(e.source_key);
  if(keys.has(e.source_key)||row?.status!=='resolved'||row.execution_action!=='create'||hash(e.intent)!==hash(row))
   throw Error('Recipe has missing, blocked, duplicate or changed intent');
  keys.add(e.source_key);
 }
 // This binds inputs; it does NOT validate the compiler's geometry/unit mappings.
 // Supply an independent validate callback to runPaced for those invariants.
 return {manifestHash,recipesHash};
}

export async function reconcileLedger({recipes,ledger,callBatch,verify,resolvePending}) {
 if(typeof verify!=='function')throw Error('Independent live geometry verification required');
 const rows=Object.entries(ledger.elements??{}),byKey=new Map(recipes.map(e=>[e.source_key,e]));
 const ids=rows.map(([,r])=>r.id);
 if(ids.some(id=>!Number.isInteger(id))||new Set(ids).size!==ids.length)throw Error('Ledger contains invalid or duplicate IDs');
 const infos=await readBatched(ids,callBatch);
 const result={verified:0,reconciled:0};
 for(let i=0;i<rows.length;i++){
  const [key,record]=rows[i],recipe=byKey.get(key),info=infos[i];
  if(!recipe||info.id!==record.id||!info.uniqueId||(record.uniqueId&&info.uniqueId!==record.uniqueId)||
    record.recipeHash!==hash(recipe.steps))throw Error('Ledger identity/recipe conflict');
  await verify(recipe,{state:'exact',id:info.id,info});
  if(record.state!=='verified'){
   if(typeof resolvePending!=='function')throw Error('Pending checkpoint needs explicit evidence persistence');
   await resolvePending(key,{...record,uniqueId:info.uniqueId,state:'verified'});result.reconciled++;
  }
  result.verified++;
 }
 return result;
}

/** Optional incremental map, only when a trustworthy native model revision is available.
 * Never use IsModified, timestamps or element counts as a revision. Without it, use live scans.
 */
export function identityIndex({snapshot,revision}) {
 if(!revision||new Set(snapshot.map(r=>r.uniqueId)).size!==snapshot.length)throw Error('Complete unique snapshot and trusted revision required');
 const rows=new Map(snapshot.map(r=>[r.uniqueId,r]));let current=revision;
 return {
  lookup(sourceKey,observedRevision){if(observedRevision!==current)throw Error('Model revision changed; rebuild snapshot');
   const matches=[...rows.values()].filter(r=>r.source_key===sourceKey);
   return matches.length===0?{state:'missing'}:matches.length===1?{state:'exact',...matches[0]}:{state:'ambiguous'};},
  checkpoint(row,{beforeRevision,afterRevision}){if(beforeRevision!==current||!afterRevision||!row.uniqueId||rows.has(row.uniqueId)||
    [...rows.values()].some(r=>r.source_key&&r.source_key===row.source_key))throw Error('Unexpected identity/revision delta');
   rows.set(row.uniqueId,row);current=afterRevision;},
 };
}
