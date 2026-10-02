import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";

const xy = z.object({ x: z.number(), y: z.number() });

const element = z
  .object({
    sourceKey: z.string().describe("Stable unique key, e.g. '1725-S301/F3/017'"),
    kind: z.enum(["footing", "column", "beam", "wall", "grid"]),
    typeId: z.union([z.number(), z.string()]).optional().describe("Type element id (not for grid)"),
    familyName: z.string().optional(),
    typeName: z.string().optional().describe("Type name (WallType name for walls); required unless typeId"),
    point: xy.optional().describe("footing/column location, mm"),
    rotationDeg: z.number().optional().describe("footing/column rotation about the vertical axis, deg (required for them)"),
    level: z.string().optional().describe("footing/beam level name"),
    offsetMm: z.number().optional().describe("footing offset from level, mm"),
    baseLevel: z.string().optional().describe("column/wall base level"),
    baseOffsetMm: z.number().optional(),
    topLevel: z.string().optional().describe("column/wall top level"),
    topOffsetMm: z.number().optional(),
    start: xy.optional().describe("beam/wall/grid start, mm"),
    end: xy.optional().describe("beam/wall/grid end, mm"),
    startOffsetMm: z.number().optional().describe("beam start level offset, mm"),
    endOffsetMm: z.number().optional().describe("beam end level offset, mm"),
    zJustification: z.enum(["top", "center", "bottom"]).optional().describe("beam; default top"),
    structuralUsage: z.enum(["girder", "joist", "other"]).optional(),
    heightMm: z.number().optional().describe("wall unconnected height (alternative to topLevel+topOffsetMm)"),
    structural: z.boolean().optional().describe("wall; default true"),
    locationLine: z
      .enum(["center", "core_center", "finish_exterior", "finish_interior", "core_exterior", "core_interior"])
      .optional(),
    name: z.string().optional().describe("grid name"),
    parameters: z
      .array(
        z.object({
          name: z.string().optional(),
          builtIn: z.string().optional(),
          value: z.union([z.string(), z.number(), z.boolean(), z.object({ id: z.union([z.number(), z.string()]) })]),
          units: z.string().optional(),
        })
      )
      .optional()
      .describe("Optional instance parameters, written with verification"),
  })
  .describe("All vertical values required for the kind; missing -> [invalid_parameter]. Units mm.");

export function registerBuildElementsTool(server: McpServer) {
  server.tool(
    "build_elements",
    "Deterministic, idempotent bulk builder for footings, columns, beams, walls and grids from a data payload (max 500). All vertical constraints are explicit (no defaults). Elements are keyed by sourceKey: upsert updates/moves existing ones, skips unchanged ones, create_only errors on existing keys. dryRun (DEFAULT true) executes in a rolled-back transaction group and reports commit-time Revit warnings. All-or-nothing, one undo step, verified readback (0.5 mm). Returns compact {ok,dryRun,committed,counts,items,warnings,errors}.",
    {
      dryRun: z.boolean().default(true).describe("Default true: preview only (rolled back). Pass false to commit."),
      mode: z.enum(["upsert", "create_only"]).default("upsert"),
      manifestHash: z.string().optional().describe("Stored next to each sourceKey"),
      transform: z
        .object({ originMm: xy.optional(), rotationDeg: z.number().optional() })
        .optional()
        .describe("model = origin + R(rotation)*p applied to every XY (element rotations add rotationDeg)"),
      elements: z.array(element).max(500),
    },
    async (args) => runTypedCommand("build_elements", args)
  );
}
