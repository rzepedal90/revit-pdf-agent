import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, PROFILES } from "../build/tools/profiles.js";
import { truncateText } from "../build/utils/toolResult.js";

test("default is all", () => {
  assert.equal(resolveProfile({}).allowed, null);
  assert.equal(resolveProfile({ REVIT_MCP_PROFILE: "all" }).allowed, null);
});

test("single and combined profiles", () => {
  const r = resolveProfile({ REVIT_MCP_PROFILE: "qa, annotation" });
  assert.ok(r.allowed.has("find_elements") && r.allowed.has("tag_all_rooms"));
  assert.ok(!r.allowed.has("create_level"));
  assert.ok(PROFILES.pdf_modeling_execute.includes("build_elements"));
});

test("unknown profile warns and falls back to all", () => {
  const r = resolveProfile({ REVIT_MCP_PROFILE: "nope" });
  assert.equal(r.allowed, null);
  assert.ok(r.warnings.length >= 1);
});

test("explicit tool allowlist", () => {
  const r = resolveProfile({ REVIT_MCP_TOOLS: "say_hello,find_elements" });
  assert.deepEqual([...r.allowed].sort(), ["find_elements", "say_hello"]);
});

test("truncation marker", () => {
  const out = truncateText("x".repeat(100), 10);
  assert.ok(out.startsWith("xxxxxxxxxx\n…truncated 90 chars"));
  assert.equal(truncateText("abc", 10), "abc");
});
