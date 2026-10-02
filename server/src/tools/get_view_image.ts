// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export function registerGetViewImageTool(server: McpServer) {
  server.tool(
    "get_view_image",
    "Read-only. Exports a Revit view to a PNG and returns it as an image together with the pixel-to-model mapping (model XY in mm of pixel (0,0) and mm per pixel). Optionally crops to a model XY rectangle (plan views). Does not change view settings. Prefer passing viewId; the active view may change.",
    {
      viewId: z
        .number()
        .int()
        .optional()
        .describe("View ElementId. Defaults to the active view"),
      pixelSize: z
        .number()
        .int()
        .min(64)
        .max(8000)
        .default(2000)
        .describe("Max long edge of the returned image in pixels (default 2000, max 8000)"),
      cropMm: z
        .object({
          minX: z.number(),
          minY: z.number(),
          maxX: z.number(),
          maxY: z.number(),
        })
        .optional()
        .describe("Optional model-space XY rectangle in millimetres to crop the image to"),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_view_image", {
            viewId: args.viewId,
            pixelSize: args.pixelSize,
            cropMm: args.cropMm,
          });
        });

        const { imageBase64, ...meta } = response ?? {};
        if (!imageBase64) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(response) }],
          };
        }
        return {
          content: [
            {
              type: "image" as const,
              data: imageBase64 as string,
              mimeType: (meta.mimeType as string) || "image/png",
            },
            { type: "text" as const, text: JSON.stringify(meta) },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `get_view_image failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
