import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";
import { parameterValueSchema, unitsDescription } from "./set_parameter.js";

export function registerSetParameterBatchTool(server: McpServer) {
  server.tool(
    "set_parameter_batch",
    "Set many parameters in one all-or-nothing transaction (validated, written, read back; any failure rolls back). Returns {ok,count,items} or {ok:false,error}.",
    {
      items: z
        .array(
          z.object({
            elementId: z.union([z.number(), z.string()]),
            name: z.string().optional(),
            builtIn: z.string().optional(),
            value: parameterValueSchema,
            units: z.string().optional().describe(unitsDescription),
            scope: z.enum(["instance", "type"]).optional(),
          })
        )
        .min(1)
        .describe("Writes to perform"),
      units: z.string().optional().describe("Default units for items that omit them"),
      scope: z.enum(["instance", "type"]).optional().describe("Default scope for items that omit it"),
      expectedCount: z
        .number()
        .int()
        .optional()
        .describe("Optional guard: fail with identity_conflict before writing if items.length differs"),
    },
    async (args) => runTypedCommand("set_parameter_batch", args)
  );
}
