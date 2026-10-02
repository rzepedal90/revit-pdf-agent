import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerAnalyzeModelStatisticsTool(server: McpServer) {
  server.tool(
    "analyze_model_statistics",
    "Model statistics: totals (elements, types, families, views, sheets), counts by category (optional type/family breakdown) and per-level distribution.",
    {
      includeDetailedTypes: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include detailed breakdown by family and type within each category. Defaults to true."),
    },
    async (args, extra) => {
      const params = {
        includeDetailedTypes: args.includeDetailedTypes ?? true,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("analyze_model_statistics", params);
        });

        return {
          content: [
            {
              type: "text",
              text: toText(response),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Analyze model statistics failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
