#!/usr/bin/env node
// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
//
// Node port of validate_dimension_manifest.py. Validates the safety and scope invariants of a Revit dimension manifest.
// Usage: node validate_dimension_manifest.mjs <dimension-manifest.json>   (exit 0 = VALID, 1 = INVALID, 2 = usage)
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MODES = new Set(['ANALYZE', 'PLAN', 'EXECUTE']);
const STATES = new Set(['resolved', 'blocked', 'excluded']);
const GROUPS = new Set(['grid_chain', 'overall', 'element_size', 'element_offset', 'support_chain', 'oblique_chain']);
const ROLES = new Set([...GROUPS, 'graphic_only', 'excluded_detail']);
const INTENTS = new Set(['reproduce_source', 'clean_documentation', 'both']);
const REQUIRED = [
  'schema_version', 'mode', 'manifest_frozen', 'parent_model_manifest_sha256', 'target', 'source_ids', 'scope',
  'dimension_type', 'layout_policy', 'dimensions', 'clarifications', 'execution_policy', 'acceptance_tests',
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonBlankString = (v) => typeof v === 'string' && v.trim() !== '';
// Python truthiness for JSON values (used for `not ref.get(...)`)
const truthy = (v) => v !== undefined && v !== null && v !== false && v !== 0 && v !== '' &&
  !(Array.isArray(v) && v.length === 0) && !(isObj(v) && Object.keys(v).length === 0);
const pyRepr = (v) => (v === undefined || v === null ? 'None' : typeof v === 'string' ? `'${v}'` :
  typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const pyList = (items) => `[${[...items].sort().map(pyRepr).join(', ')}]`;
const missingKeys = (required, obj) => required.filter((k) => !has(obj, k)).sort();

export function validateManifest(data) {
  const errors = [];
  const missing = missingKeys(REQUIRED, data);
  if (missing.length) errors.push(`missing top-level fields: ${missing.join(', ')}`);
  if (data.schema_version !== '1.0') errors.push("schema_version must be '1.0'");
  const mode = data.mode;
  if (!MODES.has(mode)) errors.push(`mode must be one of ${pyList(MODES)}`);

  const target = data.target;
  if (!isObj(target)) {
    errors.push('target must be an object');
  } else {
    const targetMissing = missingKeys(['rvt_path', 'rvt_title', 'revit_version', 'mcp_version'], target);
    if (targetMissing.length) errors.push(`target is missing fields: ${targetMissing.join(', ')}`);
  }
  if (!Array.isArray(data.source_ids) || data.source_ids.length === 0) errors.push('source_ids must be a non-empty list');

  let scope = data.scope;
  if (!isObj(scope)) {
    errors.push('scope must be an object');
    scope = {};
  }
  if (scope.enabled !== true) errors.push('scope.enabled must be true for a dimension manifest');
  let groups = scope.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    errors.push('scope.groups must be a non-empty list');
    groups = [];
  }
  const unknownGroups = [...new Set(groups.filter((g) => !GROUPS.has(g)))].sort();
  if (unknownGroups.length) errors.push(`unsupported dimension groups: ${unknownGroups.join(', ')}`);
  if (!INTENTS.has(scope.intent)) errors.push(`scope.intent must be one of ${pyList(INTENTS)}`);
  if (!Array.isArray(scope.target_view_unique_ids) || scope.target_view_unique_ids.length === 0) {
    errors.push('scope.target_view_unique_ids must be a non-empty list');
  }

  let inventory = scope.group_inventory;
  if (mode === 'EXECUTE' && scope.inventory_complete !== true) errors.push('EXECUTE requires scope.inventory_complete true');
  if (mode === 'EXECUTE' && !isObj(inventory)) {
    errors.push('EXECUTE requires scope.group_inventory');
    inventory = {};
  }

  const dimensionType = data.dimension_type;
  if (!isObj(dimensionType)) errors.push('dimension_type must be an object');
  else if (mode === 'EXECUTE' && dimensionType.verified !== true) errors.push('EXECUTE requires a verified dimension type');

  const keys = new Set();
  const signatures = new Set();
  let rows = data.dimensions;
  if (!Array.isArray(rows)) {
    errors.push('dimensions must be a list');
    rows = [];
  }
  rows.forEach((row, index) => {
    const label = `dimensions[${index}]`;
    if (!isObj(row)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const key = row.source_key;
    if (!nonBlankString(key)) errors.push(`${label}.source_key is required`);
    else if (keys.has(key)) errors.push(`duplicate source_key: ${key}`);
    else keys.add(key);
    const state = row.status;
    if (!STATES.has(state)) errors.push(`${label}.status must be one of ${pyList(STATES)}`);
    const role = row.role;
    if (!ROLES.has(role)) errors.push(`${label}.role is unsupported: ${pyRepr(role)}`);
    else if (GROUPS.has(role) && !groups.includes(role)) errors.push(`${label}.role is outside selected scope: ${role}`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) errors.push(`${label}.evidence must be a non-empty list`);
    const action = row.execution_action;
    if ((state === 'blocked' || state === 'excluded') && action !== 'none') {
      errors.push(`${label} is ${state} and must use execution_action 'none'`);
    }
    if (state === 'resolved' && action !== 'create' && action !== 'skip') {
      errors.push(`${label} is resolved and must use execution_action 'create' or 'skip'`);
    }
    const refs = row.references;
    if (state === 'resolved') {
      if (!Array.isArray(refs) || refs.length < 2) {
        errors.push(`${label}.references must contain at least two references`);
      } else {
        refs.forEach((ref, refIndex) => {
          if (!isObj(ref) || !truthy(ref.element_unique_id) || !truthy(ref.semantic_selector) || !truthy(ref.stable_representation)) {
            errors.push(`${label}.references[${refIndex}] requires element_unique_id, semantic_selector, and stable_representation`);
          }
        });
      }
      if (row.value_override !== undefined && row.value_override !== null && row.value_override !== '') {
        errors.push(`${label} must not use value_override`);
      }
    }
    const signature = row.canonical_signature;
    if (state === 'resolved') {
      if (!nonBlankString(signature)) errors.push(`${label}.canonical_signature is required`);
      else if (signatures.has(signature)) errors.push(`duplicate canonical_signature: ${signature}`);
      else signatures.add(signature);
    }
  });

  if (mode === 'EXECUTE' && isObj(inventory)) {
    for (const group of groups) {
      const summary = inventory[group];
      if (!isObj(summary)) {
        errors.push(`scope.group_inventory is missing selected group: ${group}`);
        continue;
      }
      const groupRows = rows.filter((r) => isObj(r) && r.role === group);
      const actual = {
        total: groupRows.length,
        resolved: groupRows.filter((r) => r.status === 'resolved').length,
        blocked: groupRows.filter((r) => r.status === 'blocked').length,
        excluded: groupRows.filter((r) => r.status === 'excluded').length,
      };
      for (const [key, value] of Object.entries(actual)) {
        if (summary[key] !== value) {
          errors.push(`scope.group_inventory.${group}.${key}=${pyRepr(summary[key])} does not match dimension rows (${value})`);
        }
      }
    }
  }

  let policy = data.execution_policy;
  if (!isObj(policy)) {
    errors.push('execution_policy must be an object');
    policy = {};
  }
  for (const [field, expected] of [
    ['primary_pdf_immutable', true], ['allow_move_model_elements', false], ['allow_value_override', false],
  ]) {
    if (policy[field] !== expected) errors.push(`execution_policy.${field} must be ${String(expected)}`);
  }
  if (mode === 'ANALYZE') {
    if (policy.commit_authorized !== false) errors.push('ANALYZE requires commit_authorized false');
    if (policy.expected_revit_changes !== 0) errors.push('ANALYZE requires expected_revit_changes 0');
  }
  if (mode === 'EXECUTE') {
    if (data.manifest_frozen !== true) errors.push('EXECUTE requires manifest_frozen true');
    if (policy.commit_authorized !== true) errors.push('EXECUTE requires commit_authorized true');
  }
  return errors;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    process.stderr.write('usage: validate_dimension_manifest.mjs manifest\n');
    return 2;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(argv[0], 'utf8').replace(/^﻿/, ''));
  } catch (exc) {
    process.stderr.write(`INVALID: ${exc.message}\n`);
    return 1;
  }
  if (!isObj(data)) {
    process.stderr.write('INVALID: top-level JSON value must be an object\n');
    return 1;
  }
  const errors = validateManifest(data);
  if (errors.length) {
    console.log('INVALID');
    for (const error of errors) console.log(`- ${error}`);
    return 1;
  }
  console.log('VALID');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
