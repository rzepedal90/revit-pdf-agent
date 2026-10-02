// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export function registerGetElementsInfoTool(server: McpServer) {
  server.tool(
    "get_elements_info",
    "Read-only numeric read-back for up to 200 element ids: type, location (mm, rotation deg), bbox, top/bottom elevation, base/top/host offsets, material, Comments, Mark, sourceKey. Missing ids are listed in notFound.",
    {
      ids: z.array(z.number().int()).min(1).max(200).describe("Element ids (max 200)."),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Projection: uniqueId, category, family, type, typeId, level, location, bbox, elevations, offsets, material, comments, mark, sourceKey. id is always returned. Default: all."
        ),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_elements_info", args);
        });
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `get_elements_info failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
