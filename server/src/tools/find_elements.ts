// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

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

export function registerFindElementsTool(server: McpServer) {
  server.tool(
    "find_elements",
    "Read-only search for elements by category/type/family/level/view/sourceKeyPrefix/parameterFilters with paging. Returns {total, hasMore, nextOffset, items}. Requires at least one of category, sourceKeyPrefix, viewId.",
    {
      category: z
        .string()
        .optional()
        .describe("BuiltInCategory name (e.g. OST_StructuralColumns) or display name."),
      typeName: z.string().optional().describe("Type name contains (case-insensitive)."),
      familyName: z.string().optional().describe("Family name contains (case-insensitive)."),
      levelName: z.string().optional().describe("Exact level name."),
      viewId: z.number().int().optional().describe("Restrict to elements visible in this view."),
      sourceKeyPrefix: z.string().optional().describe("Source key starts with this prefix."),
      parameterFilters: z.array(parameterFilter).optional().describe("All must match (AND)."),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Projection: uniqueId, category, family, type, typeId, level, location, bbox, elevations, offsets, material, comments, mark, sourceKey. Default: type, location. id always returned."
        ),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("find_elements", args);
        });
        return { content: [{ type: "text", text: toText(response) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `find_elements failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
