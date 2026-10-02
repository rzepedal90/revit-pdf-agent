// Tool profiles: named subsets of tools to cut the tool-definition token footprint.
// Select with REVIT_MCP_PROFILE (comma-separated, default "all") and/or REVIT_MCP_TOOLS (explicit allowlist).
// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
// This module is not a tool: register.ts skips it.

const CORE = ["say_hello", "get_current_view_info", "get_selected_elements", "send_code_to_revit"];

export const PROFILES: Record<string, string[]> = {
  core: CORE,
  pdf_modeling_analyze: [
    ...CORE,
    "get_spatial_reference",
    "get_view_image",
    "get_available_family_types",
    "get_elements_info",
    "find_elements",
    "query_where",
    "find_by_source_key",
    "analyze_model_statistics",
  ],
  pdf_modeling_execute: [
    ...CORE,
    "get_elements_info",
    "find_elements",
    "query_where",
    "find_by_source_key",
    "set_source_key",
    "build_elements",
    "set_parameter",
    "set_parameter_batch",
    "duplicate_family_type",
    "change_element_type",
    "create_grid",
    "get_available_family_types",
  ],
  qa: [
    ...CORE,
    "get_elements_info",
    "find_elements",
    "query_where",
    "find_by_source_key",
    "get_view_image",
  ],
  architecture: [
    ...CORE,
    "create_level",
    "create_grid",
    "create_room",
    "create_point_based_element",
    "create_line_based_element",
    "create_surface_based_element",
    "create_structural_framing_system",
    "get_available_family_types",
    "get_current_view_elements",
    "ai_element_filter",
    "operate_element",
    "delete_element",
  ],
  annotation: [
    ...CORE,
    "create_dimensions",
    "tag_all_rooms",
    "tag_all_walls",
    "color_elements",
    "get_current_view_elements",
    "operate_element",
  ],
  data: [
    ...CORE,
    "store_project_data",
    "store_room_data",
    "query_stored_data",
    "export_room_data",
    "get_material_quantities",
    "analyze_model_statistics",
  ],
};

export interface ProfileResolution {
  /** null = every tool is enabled. */
  allowed: Set<string> | null;
  warnings: string[];
  label: string;
}

function split(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pure resolution of the active tool set from environment variables. */
export function resolveProfile(env: Record<string, string | undefined>): ProfileResolution {
  const warnings: string[] = [];
  const profiles = split(env.REVIT_MCP_PROFILE).map((p) => p.toLowerCase());
  const tools = split(env.REVIT_MCP_TOOLS);

  const allowed = new Set<string>();
  const used: string[] = [];
  let sawAll = false;
  let sawUnknown = false;

  for (const p of profiles) {
    if (p === "all") {
      sawAll = true;
    } else if (PROFILES[p]) {
      PROFILES[p].forEach((t) => allowed.add(t));
      used.push(p);
    } else {
      sawUnknown = true;
      warnings.push(`Unknown REVIT_MCP_PROFILE "${p}" (known: all, ${Object.keys(PROFILES).join(", ")})`);
    }
  }

  if (tools.length > 0) {
    tools.forEach((t) => allowed.add(t));
    used.push(`tools[${tools.length}]`);
  }

  // Unknown names fall back to "all" unless something valid was also selected.
  if (sawAll || (sawUnknown && used.length === 0) || (profiles.length === 0 && tools.length === 0)) {
    if (sawUnknown && !sawAll) warnings.push("Falling back to profile 'all'");
    return { allowed: null, warnings, label: "all" };
  }
  return { allowed, warnings, label: used.join("+") };
}
