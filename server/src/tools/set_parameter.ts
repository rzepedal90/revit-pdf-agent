import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";

export const parameterValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.object({ id: z.union([z.number(), z.string()]) })])
  .describe(
    "Value by storage type; ElementId params take an id or {id}"
  );

export const unitsDescription =
  "Units: length mm|cm|m|ft, area mm2|cm2|m2|ft2, volume mm3|cm3|m3|ft3, or internal (feet). Default mm. Angle/force need internal.";

export function registerSetParameterTool(server: McpServer) {
  server.tool(
    "set_parameter",
    "Set one parameter on an element or its type, read it back, roll back on mismatch. Returns {ok,before,after} or {ok:false,error:{code,message}}.",
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
