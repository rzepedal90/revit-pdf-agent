import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";
import { parameterValueSchema, unitsDescription } from "./set_parameter.js";

export function registerDuplicateFamilyTypeTool(server: McpServer) {
  server.tool(
    "duplicate_family_type",
    "Duplicate a family/system type under newName and optionally set type parameters (read back). name_collision if it exists, unless reuseIfIdentical and params match. Returns {ok,typeId,name,created,reused,readback[]}.",
    {
      sourceTypeId: z.union([z.number(), z.string()]).optional().describe("Type element id to copy"),
      familyName: z.string().optional().describe("Alternative to sourceTypeId: family name"),
      typeName: z.string().optional().describe("Alternative to sourceTypeId: source type name (with familyName)"),
      newName: z.string().describe("Name of the new type"),
      parameters: z
        .array(
          z.object({
            name: z.string().optional(),
            builtIn: z.string().optional(),
            value: parameterValueSchema,
            units: z.string().optional().describe(unitsDescription),
          })
        )
        .optional()
        .describe("Type parameters to set on the new type"),
      reuseIfIdentical: z.boolean().optional().describe("Return the existing type instead of name_collision when all given params already match"),
    },
    async (args) => runTypedCommand("duplicate_family_type", args)
  );
}
