import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerCreateSurfaceBasedElementTool(server: McpServer) {
  server.tool(
    "create_surface_based_element",
    "Batch-create surface-based elements (floors, ceilings, roofs) from a closed boundary loop, type id, thickness and level. mm.",
    {
      data: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Description of the element (e.g., floor, ceiling)"),
            category: z
              .enum(["OST_Floors", "OST_Ceilings", "OST_Roofs"])
              .optional()
              .describe("The Revit built-in category for the element. Use OST_Floors for floors, OST_Ceilings for ceilings, OST_Roofs for roofs. If not specified, will be determined from typeId."),
            typeId: z
              .number()
              .optional()
              .describe("The ID of the family type to create."),
            boundary: z
              .object({
                outerLoop: z
                  .array(
                    z.object({
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
                  )
                  .min(3)
                  .describe("Array of line segments defining the boundary"),
              })
              .describe("Boundary definition with outer loop"),
            thickness: z.number().describe("Thickness of the element"),
            baseLevel: z.number().describe("Base level height"),
            baseOffset: z.number().describe("Offset from the base level"),
          })
        )
        .describe("Array of surface-based elements to create"),
    },
    async (args, extra) => {
      const params = args;
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "create_surface_based_element",
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
              text: `Create surface-based element failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
