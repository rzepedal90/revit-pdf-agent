import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerCreatePointBasedElementTool(server: McpServer) {
  server.tool(
    "create_point_based_element",
    "Batch-create point-based elements (doors, windows, furniture) at a location with type id, size, level and rotation. mm.",
    {
      data: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Description of the element (e.g., door, window)"),
            typeId: z
              .number()
              .optional()
              .describe("The ID of the family type to create."),
            locationPoint: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .describe(
                "The position coordinates where the element will be placed"
              ),
            width: z.number().describe("Width of the element in mm"),
            depth: z.number().optional().describe("Depth of the element in mm"),
            height: z.number().describe("Height of the element in mm"),
            baseLevel: z.number().describe("Base level height"),
            baseOffset: z.number().describe("Offset from the base level"),
            rotation: z
              .number()
              .optional()
              .describe("Rotation angle in degrees (0-360)"),
            hostWallId: z
              .number()
              .optional()
              .describe(
                "The ElementId of a specific wall to use as host for doors/windows. " +
                "If not provided, the nearest wall will be auto-detected."
              ),
            facingFlipped: z
              .boolean()
              .optional()
              .default(false)
              .describe(
                "Whether to flip the facing direction of the door/window. " +
                "When true, the element faces the opposite side of the wall."
              ),
          })
        )
        .describe("Array of point-based elements to create"),
    },
    async (args, extra) => {
      const params = args;

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "create_point_based_element",
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
              text: `Create point-based element failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
