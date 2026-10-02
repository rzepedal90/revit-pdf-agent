import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerCreateDimensionsTool(server: McpServer) {
  server.tool(
    "create_dimensions",
    "Create dimensions in the current view between element ids, or between two points with auto reference detection. mm.",
    {
      dimensions: z
        .array(
          z.object({
            startPoint: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .describe("Start point of the dimension line (mm)"),
            endPoint: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .describe("End point of the dimension line (mm)"),
            linePoint: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .optional()
              .describe(
                "Location of the dimension line itself (mm). If not provided, defaults to midpoint offset by 1 foot"
              ),
            elementIds: z
              .array(z.number())
              .optional()
              .describe(
                "Element IDs to dimension between. If provided, references are extracted from these elements. If empty, references are auto-detected at start/end points"
              ),
            dimensionType: z
              .string()
              .optional()
              .default("Linear")
              .describe(
                "Dimension type (default: 'Linear')"
              ),
            dimensionStyleId: z
              .number()
              .optional()
              .default(-1)
              .describe(
                "Element ID of the dimension style to apply. -1 for default style"
              ),
            viewId: z
              .number()
              .optional()
              .default(-1)
              .describe(
                "Element ID of the view to create the dimension in. -1 for active view"
              ),
          })
        )
        .describe("Array of dimensions to create"),
    },
    async (args, extra) => {
      const params = {
        dimensions: args.dimensions,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("create_dimensions", params);
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
              text: `Dimension creation failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
