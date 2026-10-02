// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
// NOTE (our MCP): assumes THEIR addin API (`callBatch`, stable-reference resolver). Dimension execution is NOT supported in our MCP yet.
/** Deterministic execution primitives. No cross-run geometry/dry-run cache. */
import {createHash} from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const payloadHash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Share exact selectors within one uninterrupted run, scoped to owning view and units. */
export function referenceCache(callRevit) {
  const cache = new Map();
  return async ({viewId, units = 'meters', references}) => {
    const keys = references.map(spec => canonical({viewId, units, spec}));
    const missing = new Map();
    references.forEach((spec, i) => { if (!cache.has(keys[i])) missing.set(keys[i], spec); });
    const entries = [...missing];
    for (let offset = 0; offset < entries.length; offset += 200) {
      const chunk = entries.slice(offset, offset + 200);
      const response = await callRevit('resolve_dimension_references', {viewId, units, references: chunk.map(e => e[1])});
      if (!response.ok || response.data?.references?.length !== chunk.length)
        throw new Error('Reference resolver failed or returned incomplete inventory');
      response.data.references.forEach((row, i) => cache.set(chunk[i][0], row));
    }
    return keys.map((key, index) => ({...cache.get(key), index}));
  };
}

/** Atomic batch dry-run immediately followed by identical commit, if explicitly authorized.
 * The caller must validate the frozen manifest, exact live target, protected baselines,
 * and perform complete post-commit QA. Evidence is persisted before every mutation.
 * No retry on uncertain transport failures: inspect source identities first.
 */
export async function runBatches({steps, callRevitBatch, writeEvidence, commit = false,
  authorized = false, batchSize = 24, guard}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error('Invalid batch size');
  if (typeof guard !== 'function' || typeof writeEvidence !== 'function') throw new Error('Guard and evidence writer required');
  if (commit && !authorized) throw new Error('Commit requires frozen-manifest authorization');
  const frozen = JSON.parse(JSON.stringify(steps));
  const keys = new Set();
  for (const step of frozen) {
    const p = step.params;
    if (step.command !== 'create_aligned_dimension' || !p?.sourceKey || !p.canonicalSignature ||
        !Array.isArray(p.expectedValues) || !p.expectedValues.length ||
        !p.expectedValues.every(Number.isFinite) || !Number.isFinite(p.tolerance) || p.tolerance <= 0 ||
        !p.dimensionTypeUniqueId || !Number.isInteger(p.viewId) || p.units !== 'meters' ||
        !['start','end'].every(k => p.line?.[k] && ['x','y','z'].every(a => Number.isFinite(p.line[k][a]))) ||
        !Array.isArray(p.references) || p.references.length < 2 ||
        !p.references.every(r => r.selector === 'stable' && r.elementUniqueId && r.stableRepresentation) ||
        p.valueOverride != null || p.value_override != null)
      throw new Error('Only deterministic dimension payloads with expected values are allowed');
    if (keys.has(p.sourceKey)) throw new Error('Duplicate source key');
    keys.add(p.sourceKey);
  }
  const summary = {planned: frozen.length, batches: 0, dryPassed: 0, committedSteps: 0, hashes: []};
  for (let offset = 0; offset < frozen.length; offset += batchSize) {
    const batch = frozen.slice(offset, offset + batchSize);
    const hash = payloadHash(batch);
    await guard();
    const dry = await callRevitBatch(JSON.parse(JSON.stringify(batch)), true, true);
    await writeEvidence({offset, hash, phase: 'dry', payload: batch, response: dry});
    if (!dry.ok || dry.hadFailures || dry.results?.length !== batch.length || dry.results.some(r => !r.ok))
      throw new Error(`Dry-run blocked batch ${offset}; inspect evidence, do not commit`);
    summary.batches++; summary.dryPassed += batch.length; summary.hashes.push(hash);
    if (commit) {
      await guard();
      if (payloadHash(batch) !== hash) throw new Error('Payload changed after dry-run');
      const result = await callRevitBatch(JSON.parse(JSON.stringify(batch)), true, false);
      await writeEvidence({offset, hash, phase: 'commit', response: result});
      if (!result.ok || result.hadFailures || result.committed !== true ||
          result.results?.length !== batch.length || result.results.some(r => !r.ok))
        throw new Error(`Commit failed/uncertain at ${offset}; inspect identities before resuming`);
      summary.committedSteps += batch.length;
    }
  }
  return summary;
}
