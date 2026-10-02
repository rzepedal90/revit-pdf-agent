// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const parameterFilter = z.object({
  name: z
    .string()
    .describe("Parameter name (instance, then type). Pseudo-parameter SourceKey is supported."),
  op: z.enum(["eq", "neq", "contains", "gt", "lt", "is_empty"]).default("eq"),
  value: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe("Comparison value. Length parameters are compared in mm."),
  scope: z.enum(["instance", "type"]).optional(),
});

export function registerQueryWhereTool(server: McpServer) {
  server.tool(
    "query_where",
    "Read-only count and ids of elements matching a parameter predicate. Returns {count, ids (up to limit), truncated} and, with groupBy, {groups:[{key,count}]}. Use for 'how many X exist' checks.",
    {
      category: z
        .string()
        .optional()
        .describe("BuiltInCategory name (e.g. OST_StructuralFoundation) or display name."),
      typeName: z.string().optional().describe("Type name contains (case-insensitive)."),
      familyName: z.string().optional().describe("Family name contains (case-insensitive)."),
      levelName: z.string().optional().describe("Exact level name."),
      viewId: z.number().int().optional(),
      sourceKeyPrefix: z.string().optional(),
      parameterFilters: z.array(parameterFilter).optional().describe("All must match (AND)."),
      scope: z
        .enum(["instance", "type"])
        .optional()
        .describe("Default parameter scope for filters without their own scope."),
      groupBy: z.enum(["type", "level", "category"]).optional(),
      limit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(50)
        .describe("Max ids returned (counts are always exact)."),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("query_where", args);
        });
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `query_where failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
