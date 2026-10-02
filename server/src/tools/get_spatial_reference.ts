// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerGetSpatialReferenceTool(server: McpServer) {
  server.tool(
    "get_spatial_reference",
    "Read-only. Returns model-space placement data in both millimetres and feet for grids (endpoints, direction, pairwise XY intersections), image/PDF instances (type, source path, size, scale, 4 model-space corners and center) and any other element (bbox/location), plus the view frame (view/right/up directions, scale, crop box in model coordinates). Use it to compute a drawing-to-model transform numerically.",
    {
      ids: z
        .array(z.number().int())
        .min(1)
        .max(200)
        .describe("ElementIds (1-200): grids, ImageInstance, or any element"),
      viewId: z
        .number()
        .int()
        .optional()
        .describe("Optional view ElementId for view-specific extents/bboxes and the view frame"),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_spatial_reference", {
            ids: args.ids,
            viewId: args.viewId,
          });
        });
        return {
          content: [{ type: "text", text: toText(response) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `get_spatial_reference failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
