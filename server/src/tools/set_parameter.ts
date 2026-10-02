import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";

export const parameterValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.object({ id: z.union([z.number(), z.string()]) })])
  .describe(
    "New value. String/number/boolean by storage type; for ElementId parameters pass an id (number) or {id}."
  );

export const unitsDescription =
  "Units of a numeric value for length/area/volume parameters: length mm|cm|m|ft, area mm2|cm2|m2|ft2, volume mm3|cm3|m3|ft3, or 'internal' (raw Revit feet). Default: mm / mm2 / mm3. Dimensionless numbers ignore units. Angle/force and other measurable specs require 'internal'.";

export function registerSetParameterTool(server: McpServer) {
  server.tool(
    "set_parameter",
    "Set one parameter on an element (instance) or its type, then regenerate, read it back and fail with a rollback on mismatch. Returns compact {ok,before,after} (display + raw) or {ok:false,error:{code,message}}. Codes: invalid_parameter, not_found, unit_unsupported, readback_mismatch, revit_error.",
    {
      elementId: z.union([z.number(), z.string()]).describe("Element id"),
      name: z.string().optional().describe("Parameter name (or use builtIn)"),
      builtIn: z
        .string()
        .optional()
        .describe("BuiltInParameter enum name, e.g. WALL_USER_HEIGHT_PARAM (alternative to name)"),
      value: parameterValueSchema,
      units: z.string().optional().describe(unitsDescription),
      scope: z
        .enum(["instance", "type"])
        .default("instance")
        .describe("'type' writes the parameter on the element's type"),
    },
    async (args) => runTypedCommand("set_parameter", args)
  );
}
