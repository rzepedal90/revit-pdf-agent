// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerFindBySourceKeyTool(server: McpServer) {
  server.tool(
    "find_by_source_key",
    "Read-only lookup of elements by exact source keys and/or key prefix. Returns {total, truncated, matches, notFound, duplicates} where duplicates lists keys carried by more than one element.",
    {
      keys: z.array(z.string()).optional().describe("Exact source keys."),
      prefix: z.string().optional().describe("Source key prefix."),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("find_by_source_key", args);
        });
        return { content: [{ type: "text", text: toText(response) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `find_by_source_key failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
