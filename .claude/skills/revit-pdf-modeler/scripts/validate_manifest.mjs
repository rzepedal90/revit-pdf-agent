#!/usr/bin/env node
// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// See THIRD_PARTY_NOTICES.md at the repository root for the full license text.
//
// Node port of validate_manifest.py. Validates the invariants of a revit-pdf-modeler run manifest.
// Usage: node validate_manifest.mjs <manifest.json>   (exit 0 = VALID, 1 = INVALID, 2 = usage)
// Addition over the original: optional acceptance_tests.expected_counts rule (see validateExpectedCounts).
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MODES = new Set(['ANALYZE', 'PLAN', 'EXECUTE']);
const STATES = new Set(['resolved', 'blocked', 'excluded']);
const ALLOWED_CATEGORIES = new Set([
  'grids', 'structural_columns', 'structural_framing', 'structural_foundations',
  'structural_walls', 'structural_floors', 'openings',
]);
const REQUIRED_TOP_LEVEL = [
  'schema_version', 'mode', 'manifest_frozen', 'target', 'sources',
  'scope', 'documentation', 'coordinate_basis', 'levels', 'type_manifest',
  'element_manifest', 'clarifications', 'execution_policy', 'acceptance_tests',
];
const REQUIRED_TARGET_FIELDS = [
  'rvt_path', 'rvt_title', 'revit_version', 'mcp_version', 'active_view',
  'unit_system', 'phase', 'workset', 'design_option',
];
const REQUIRED_SOURCE_FIELDS = [
  'source_id', 'role', 'path', 'sha256', 'sheet', 'revision', 'units',
  'registered_in_revit', 'positional_authority', 'human_aligned',
  'human_scaled', 'pinned_expected', 'immutable', 'drawing_regions',
];
const DIMENSION_GROUPS = new Set([
  'grid_chain', 'overall', 'element_size', 'element_offset', 'support_chain', 'oblique_chain',
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k) => (isObj(o) && has(o, k) ? o[k] : undefined);
const nonBlankString = (v) => typeof v === 'string' && v.trim() !== '';
// Python truthiness for JSON values
const truthy = (v) => v !== undefined && v !== null && v !== false && v !== 0 && v !== '' &&
  !(Array.isArray(v) && v.length === 0) && !(isObj(v) && Object.keys(v).length === 0);
const sortedList = (iterable) => [...iterable].sort();
const pyRepr = (v) => (v === undefined || v === null ? 'None' : typeof v === 'string' ? `'${v}'` :
  typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const pyList = (items) => `[${items.map(pyRepr).join(', ')}]`;
const missingKeys = (required, obj) => required.filter((k) => !has(obj, k)).sort();

export function validateManifest(data) {
  const errors = [];
  const missing = missingKeys(REQUIRED_TOP_LEVEL, data);
  if (missing.length) errors.push(`missing top-level fields: ${missing.join(', ')}`);
  if (data.schema_version !== '1.0') errors.push("schema_version must be '1.0'");

  const mode = data.mode;
  if (!MODES.has(mode)) errors.push(`mode must be one of ${pyList(sortedList(MODES))}`);

  const target = data.target;
  if (!isObj(target)) {
    errors.push('target must be an object');
  } else {
    const missingTarget = missingKeys(REQUIRED_TARGET_FIELDS, target);
    if (missingTarget.length) errors.push(`target is missing fields: ${missingTarget.join(', ')}`);
  }

  let sources = data.sources;
  if (!Array.isArray(sources)) {
    errors.push('sources must be a list');
    sources = [];
  }
  const sourceIds = new Set();
  sources.forEach((source, index) => {
    const label = `sources[${index}]`;
    if (!isObj(source)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const missingSource = missingKeys(REQUIRED_SOURCE_FIELDS, source);
    if (missingSource.length) errors.push(`${label} is missing fields: ${missingSource.join(', ')}`);
    const sourceId = source.source_id;
    if (!nonBlankString(sourceId)) errors.push(`${label}.source_id is required`);
    else if (sourceIds.has(sourceId)) errors.push(`duplicate source_id: ${sourceId}`);
    else sourceIds.add(sourceId);
    if (source.role !== 'primary' && source.role !== 'supplementary') {
      errors.push(`${label}.role must be 'primary' or 'supplementary'`);
    }
    if (source.role === 'supplementary' && source.registered_in_revit !== true &&
        source.positional_authority !== false) {
      errors.push(`${label} is not registered in Revit and cannot have positional authority`);
    }
  });
  const primaries = sources.filter((s) => isObj(s) && s.role === 'primary');
  if (primaries.length !== 1) {
    errors.push('sources must contain exactly one primary source');
  } else if (!['human_aligned', 'human_scaled', 'pinned_expected', 'immutable'].every((f) => primaries[0][f] === true)) {
    errors.push('primary source must be human-aligned, human-scaled, pinned, and immutable');
  } else if (primaries[0].registered_in_revit !== true || primaries[0].positional_authority !== true) {
    errors.push('primary source must be registered in Revit and have positional authority');
  }

  const flowCategories = validateFlowManifest(data.flow_manifest, errors);
  const allowedCategories = new Set([...ALLOWED_CATEGORIES, ...flowCategories]);

  let scope = data.scope;
  if (!isObj(scope)) {
    errors.push('scope must be an object');
    scope = {};
  }
  let categories = scope.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    errors.push('scope.categories must be a non-empty list');
    categories = [];
  }
  const unknown = sortedList(new Set(categories.filter((c) => !allowedCategories.has(c))));
  if (unknown.length) errors.push(`unsupported scope categories: ${unknown.join(', ')}`);
  if (scope.rebar !== false) errors.push('scope.rebar must be false');

  let documentation = data.documentation;
  if (!isObj(documentation)) {
    errors.push('documentation must be an object');
    documentation = {};
  }
  let dimensions = documentation.dimensions;
  if (!isObj(dimensions)) {
    errors.push('documentation.dimensions must be an object');
    dimensions = {};
  }
  const enabled = dimensions.enabled;
  if (typeof enabled !== 'boolean') errors.push('documentation.dimensions.enabled must be a boolean');
  if (enabled === true) {
    const groups = dimensions.groups;
    if (!Array.isArray(groups) || groups.length === 0) {
      errors.push('enabled dimensions require a non-empty groups list');
    } else if (groups.some((g) => !DIMENSION_GROUPS.has(g))) {
      errors.push('documentation.dimensions.groups contains unsupported values');
    }
    if (!Array.isArray(dimensions.target_views) || dimensions.target_views.length === 0) {
      errors.push('enabled dimensions require non-empty target_views');
    }
    if (!['reproduce_source', 'clean_documentation', 'both'].includes(dimensions.intent)) {
      errors.push('enabled dimensions require a valid intent');
    }
  }

  let basis = data.coordinate_basis;
  if (!isObj(basis)) {
    errors.push('coordinate_basis must be an object');
    basis = {};
  }
  if (categories.includes('grids')) {
    for (const field of ['origin', 'positive_x', 'positive_y', 'coordinate_policy', 'anchors']) {
      if (!truthy(basis[field])) errors.push(`coordinate_basis.${field} is required when grids are in scope`);
    }
    if (!Array.isArray(basis.registration_checks)) errors.push('coordinate_basis.registration_checks must be a list');
  }

  const allKeys = new Set();
  for (const manifestName of ['type_manifest', 'element_manifest']) {
    const rows = data[manifestName];
    if (!Array.isArray(rows)) {
      errors.push(`${manifestName} must be a list`);
      continue;
    }
    rows.forEach((row, index) => {
      const label = `${manifestName}[${index}]`;
      if (!isObj(row)) {
        errors.push(`${label} must be an object`);
        return;
      }
      const key = row.source_key;
      if (!nonBlankString(key)) errors.push(`${label}.source_key is required`);
      else if (allKeys.has(key)) errors.push(`duplicate source_key: ${key}`);
      else allKeys.add(key);
      const state = row.status;
      if (!STATES.has(state)) errors.push(`${label}.status must be one of ${pyList(sortedList(STATES))}`);
      const category = row.category;
      if (!allowedCategories.has(category)) errors.push(`${label}.category is unsupported: ${pyRepr(category)}`);
      else if (!categories.includes(category)) errors.push(`${label}.category is outside selected scope: ${category}`);
      if (!Array.isArray(row.evidence) || row.evidence.length === 0) errors.push(`${label}.evidence must be a non-empty list`);
      if (manifestName === 'type_manifest') {
        const action = row.action;
        if ((state === 'blocked' || state === 'excluded') && action !== 'blocked') {
          errors.push(`${label} is ${state} and must use action 'blocked'`);
        }
        if (state === 'resolved' && !['reuse', 'duplicate', 'load'].includes(action)) {
          errors.push(`${label} is resolved and must use action 'reuse', 'duplicate', or 'load'`);
        }
      }
      if (manifestName === 'element_manifest' && (state === 'blocked' || state === 'excluded')) {
        if (row.execution_action !== 'none') errors.push(`${label} is ${state} and must use execution_action 'none'`);
      }
    });
  }

  const clarifications = data.clarifications;
  if (!Array.isArray(clarifications)) {
    errors.push('clarifications must be a list');
  } else {
    const ids = new Set();
    clarifications.forEach((row, index) => {
      const label = `clarifications[${index}]`;
      if (!isObj(row)) {
        errors.push(`${label} must be an object`);
        return;
      }
      for (const field of ['id', 'topic', 'status', 'affected_source_keys', 'evidence', 'question']) {
        if (!has(row, field)) errors.push(`${label}.${field} is required`);
      }
      const cid = row.id;
      if (ids.has(cid)) errors.push(`duplicate clarification id: ${cid}`);
      else if (typeof cid === 'string') ids.add(cid);
      if (row.status !== 'open' && row.status !== 'answered') errors.push(`${label}.status must be 'open' or 'answered'`);
    });
  }

  let policy = data.execution_policy;
  if (!isObj(policy)) {
    errors.push('execution_policy must be an object');
    policy = {};
  }
  for (const [field, expected] of [
    ['primary_pdf_immutable', true], ['anchor_grids_immutable', true],
    ['allow_delete_existing', false], ['allow_modify_existing_types', false],
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

  validateExpectedCounts(data, errors);
  if (mode === 'PLAN' || mode === 'EXECUTE') validateExecutableGeometry(data, errors);
  return errors;
}

// ---- Build-ready conventions (PLAN/EXECUTE); see references/manifest-schema.md ----------------------------------
export const KIND_BY_CATEGORY = {
  grids: 'grid', structural_foundations: 'footing', structural_columns: 'column',
  structural_framing: 'beam', structural_walls: 'wall',
};
const Z_JUSTIFICATIONS = new Set(['top', 'center', 'bottom']);
export const DATUM_RULE_KINDS = ['footing', 'column', 'beam', 'wall'];
const isInt = Number.isInteger;
const isXY = (v) => Array.isArray(v) && v.length === 2 && v.every(isInt);

/** ANALYZE leniency: non-fatal notes (currently a missing/incomplete datum_table). */
export function manifestWarnings(data) {
  const warnings = [];
  if (isObj(data) && data.mode === 'ANALYZE') {
    const probe = [];
    validateDatumTable(data.datum_table, probe);
    for (const message of probe) warnings.push(`datum_table (required before PLAN/EXECUTE): ${message}`);
  }
  return warnings;
}

export function validateDatumTable(table, errors) {
  if (!isObj(table)) {
    errors.push('datum_table must be an object {npt_mm, sf_mm, rules:{footing|column|beam|wall:{top,bottom}}}');
    return;
  }
  for (const key of ['npt_mm', 'sf_mm']) {
    if (!isInt(table[key])) errors.push(`datum_table.${key} must be an integer (mm)`);
  }
  for (const key of ['og_mm', 'top_of_footing_mm']) {
    if (has(table, key) && !isInt(table[key])) errors.push(`datum_table.${key} must be an integer (mm)`);
  }
  const rules = table.rules;
  if (!isObj(rules)) {
    errors.push('datum_table.rules must be an object with per-category top/bottom rules');
    return;
  }
  for (const kind of DATUM_RULE_KINDS) {
    const rule = rules[kind];
    if (!isObj(rule) || !nonBlankString(rule.top) || !nonBlankString(rule.bottom)) {
      errors.push(`datum_table.rules.${kind} must have non-blank 'top' and 'bottom' (text rule or datum reference)`);
    }
  }
}

function validateExecutableGeometry(data, errors) {
  validateDatumTable(data.datum_table, errors);
  const basis = isObj(data.coordinate_basis) ? data.coordinate_basis : {};
  const t = basis.transform_to_model;
  if (!isObj(t) || !isObj(t.originMm) || !isInt(t.originMm.x) || !isInt(t.originMm.y) ||
      typeof t.rotationDeg !== 'number' || !Number.isFinite(t.rotationDeg)) {
    errors.push('coordinate_basis.transform_to_model must be {originMm:{x,y integers}, rotationDeg number}');
  }
  const types = new Map();
  if (Array.isArray(data.type_manifest)) {
    data.type_manifest.forEach((row, i) => {
      if (!isObj(row)) return;
      types.set(row.source_key, row);
      if (row.status !== 'resolved') return;
      const label = `type_manifest[${i}] (${row.source_key})`;
      if (!nonBlankString(row.family)) errors.push(`${label}.family is required`);
      if (!nonBlankString(row.type)) errors.push(`${label}.type is required`);
      if (!isObj(row.dimensions_mm) || Object.keys(row.dimensions_mm).length === 0 ||
          !Object.values(row.dimensions_mm).every(isInt)) {
        errors.push(`${label}.dimensions_mm must be a non-empty object of integer mm`);
      }
      if (!nonBlankString(row.material)) errors.push(`${label}.material is required`);
    });
  }
  if (!Array.isArray(data.element_manifest)) return;
  data.element_manifest.forEach((row, i) => {
    if (!isObj(row) || row.status !== 'resolved') return;
    const kind = KIND_BY_CATEGORY[row.category];
    const label = `element_manifest[${i}] (${row.source_key})`;
    if (!kind) {
      errors.push(`${label}: category ${pyRepr(row.category)} has no build_elements mapping`);
      return;
    }
    if (row.execution_action !== 'create') errors.push(`${label}: resolved rows must use execution_action 'create'`);
    if (has(row, 'group') && !nonBlankString(row.group)) errors.push(`${label}.group must be a non-blank string`);
    if (kind === 'grid') {
      if (!nonBlankString(row.name)) errors.push(`${label}.name is required for grids`);
    } else {
      const type = types.get(row.type_key);
      if (!type) errors.push(`${label}.type_key does not reference a type_manifest row`);
      else if (type.status !== 'resolved') errors.push(`${label}.type_key references a ${type.status} type`);
    }
    const g = row.geometry_mm;
    const z = row.z_constraints;
    if (!isObj(g)) { errors.push(`${label}.geometry_mm must be an object`); return; }
    if (kind === 'footing' || kind === 'column') {
      if (!isInt(g.x) || !isInt(g.y)) errors.push(`${label}.geometry_mm.x/y must be integers (mm)`);
      if (typeof g.rotation_deg !== 'number' || !Number.isFinite(g.rotation_deg)) {
        errors.push(`${label}.geometry_mm.rotation_deg must be a number`);
      }
    } else if (!isXY(g.start) || !isXY(g.end)) {
      errors.push(`${label}.geometry_mm.start/end must be [x,y] integer mm`);
    }
    if (kind === 'grid') return;
    if (!isObj(z)) { errors.push(`${label}.z_constraints must be an object`); return; }
    const need = (names, ints) => {
      for (const n of names) {
        const ok = ints.includes(n) ? isInt(z[n]) : nonBlankString(z[n]);
        if (!ok) errors.push(`${label}.z_constraints.${n} must be ${ints.includes(n) ? 'an integer (mm)' : 'a level name'}`);
      }
    };
    if (kind === 'footing') need(['level', 'offset_mm'], ['offset_mm']);
    if (kind === 'column') need(['base_level', 'base_offset_mm', 'top_level', 'top_offset_mm'], ['base_offset_mm', 'top_offset_mm']);
    if (kind === 'beam') {
      need(['level', 'start_offset_mm', 'end_offset_mm'], ['start_offset_mm', 'end_offset_mm']);
      if (!Z_JUSTIFICATIONS.has(z.z_justification)) errors.push(`${label}.z_constraints.z_justification must be top|center|bottom`);
    }
    if (kind === 'wall') {
      need(['base_level', 'base_offset_mm'], ['base_offset_mm']);
      const hasTop = has(z, 'top_level') || has(z, 'top_offset_mm');
      const hasHeight = has(z, 'height_mm');
      if (hasTop === hasHeight) errors.push(`${label}.z_constraints needs exactly one of (top_level+top_offset_mm) or height_mm`);
      else if (hasTop) need(['top_level', 'top_offset_mm'], ['top_offset_mm']);
      else if (!isInt(z.height_mm) || z.height_mm <= 0) errors.push(`${label}.z_constraints.height_mm must be a positive integer (mm)`);
    }
  });
}

/**
 * NEW (not in the original): when acceptance_tests.expected_counts is a non-empty object, the number of
 * `resolved` element_manifest rows per category must equal it. Categories with resolved rows but absent from
 * expected_counts count as expected 0 (so unlisted resolved rows fail). An absent or empty object disables the rule.
 */
function validateExpectedCounts(data, errors) {
  const expected = get(data.acceptance_tests, 'expected_counts');
  if (expected === undefined) return;
  if (!isObj(expected)) {
    errors.push('acceptance_tests.expected_counts must be an object of category -> integer');
    return;
  }
  if (Object.keys(expected).length === 0) return;
  const actual = {};
  if (Array.isArray(data.element_manifest)) {
    for (const row of data.element_manifest) {
      if (isObj(row) && row.status === 'resolved') actual[row.category] = (actual[row.category] ?? 0) + 1;
    }
  }
  for (const [category, count] of Object.entries(expected)) {
    if (!Number.isInteger(count) || count < 0) errors.push(`acceptance_tests.expected_counts.${category} must be a non-negative integer`);
  }
  for (const category of sortedList(new Set([...Object.keys(expected), ...Object.keys(actual)]))) {
    const want = expected[category] ?? 0;
    const got = actual[category] ?? 0;
    if (Number.isInteger(want) && want !== got) {
      errors.push(`acceptance_tests.expected_counts.${category}=${want} does not match resolved element rows (${got})`);
    }
  }
}

/** Validate optional frozen topology and return its explicitly authorized categories. */
export function validateFlowManifest(value, errors) {
  if (value === undefined || value === null) return new Set();
  if (!isObj(value) || value.schema_version !== 1) {
    errors.push('flow_manifest must be an object with schema_version 1');
    return new Set();
  }
  const stages = value.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    errors.push('flow_manifest.stages must be a non-empty list');
    return new Set();
  }
  const ids = [];
  const categories = new Set();
  const dependencies = {};
  stages.forEach((stage, index) => {
    const label = `flow_manifest.stages[${index}]`;
    if (!isObj(stage)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const stageId = stage.id;
    if (typeof stageId !== 'string' || !stageId.startsWith('stage:')) {
      errors.push(`${label}.id must begin with 'stage:'`);
      return;
    }
    if (ids.includes(stageId)) errors.push(`duplicate flow stage: ${stageId}`);
    ids.push(stageId);
    if (!nonBlankString(stage.label)) errors.push(`${label}.label is required`);
    if (!nonBlankString(stage.source)) errors.push(`${label}.source is required`);
    const stageCategories = stage.categories;
    if (!Array.isArray(stageCategories) || stageCategories.some((c) => typeof c !== 'string' || !c)) {
      errors.push(`${label}.categories must be a string list`);
    } else {
      const overlap = sortedList([...categories].filter((c) => stageCategories.includes(c)));
      if (overlap.length) errors.push(`flow categories have multiple owners: ${overlap.join(', ')}`);
      stageCategories.forEach((c) => categories.add(c));
    }
    const deps = stage.depends_on;
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
      errors.push(`${label}.depends_on must be a string list`);
      dependencies[stageId] = [];
    } else {
      dependencies[stageId] = deps;
    }
  });
  const positions = new Map();
  ids.forEach((id, i) => positions.set(id, i)); // later duplicates win, as in the original dict comprehension
  for (const [stageId, deps] of Object.entries(dependencies)) {
    for (const dep of deps) {
      if (!positions.has(dep)) errors.push(`flow stage ${stageId} has unknown dependency ${dep}`);
      else if (positions.get(dep) >= positions.get(stageId)) errors.push(`flow dependency ${dep} must precede ${stageId}`);
    }
  }
  const qa = value.qa;
  if (!isObj(qa) || typeof qa.enabled !== 'boolean') errors.push('flow_manifest.qa.enabled must be a boolean');
  return categories;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    process.stderr.write('usage: validate_manifest.mjs manifest\n');
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
  for (const warning of manifestWarnings(data)) process.stderr.write(`WARNING: ${warning}\n`);
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
