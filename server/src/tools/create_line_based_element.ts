import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerCreateLineBasedElementTool(server: McpServer) {
  server.tool(
    "create_line_based_element",
    "Batch-create line-based elements (walls, beams, ducts) from a start/end line, type id, thickness, height and level. mm.",
    {
      data: z
        .array(
          z.object({
            category: z
              .string()
              .describe("Revit built-in category (e.g., OST_Walls, OST_StructuralFraming, OST_DuctCurves)"),
            typeId: z
              .number()
              .optional()
              .describe("The ID of the family type to create."),
            locationLine: z
              .object({
                p0: z.object({
                  x: z.number(),
                  y: z.number(),
                  z: z.number(),
                }),
                p1: z.object({
                  x: z.number(),
                  y: z.number(),
                  z: z.number(),
                }),
              })
              .describe("The line defining the element's location"),
            thickness: z
              .number()
              .describe(
                "Thickness/width of the element (e.g., wall thickness)"
              ),
            height: z
              .number()
              .describe("Height of the element (e.g., wall height)"),
            baseLevel: z.number().describe("Base level height"),
            baseOffset: z.number().describe("Offset from the base level"),
          })
        )
        .describe("Array of line-based elements to create"),
    },
    async (args, extra) => {
      const params = args;

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "create_line_based_element",
            params
          );
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
              text: `Create line-based element failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
