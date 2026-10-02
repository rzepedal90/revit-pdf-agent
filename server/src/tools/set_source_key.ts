// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export function registerSetSourceKeyTool(server: McpServer) {
  server.tool(
    "set_source_key",
    "Write stable source keys (e.g. 1725-S301/F3/017) onto elements via Extensible Storage, in a transaction named 'Set source keys'. Fails per item if the key is already used by another element unless allowDuplicate.",
    {
      items: z
        .array(
          z.object({
            id: z.number().int(),
            sourceKey: z.string().min(1),
            manifestHash: z.string().optional(),
          })
        )
        .min(1)
        .max(500),
      allowDuplicate: z.boolean().default(false),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("set_source_key", args);
        });
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `set_source_key failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
