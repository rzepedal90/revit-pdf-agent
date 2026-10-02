import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerGetMaterialQuantitiesTool(server: McpServer) {
  server.tool(
    "get_material_quantities",
    "Material quantities: per material name, class, area, volume and element count.",
    {
      categoryFilters: z
        .array(z.string())
        .optional()
        .describe("Optional list of Revit category names to filter by (e.g., ['OST_Walls', 'OST_Floors', 'OST_Roofs']). If not specified, all categories are included."),
      selectedElementsOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to only analyze currently selected elements. Defaults to false (analyze entire project)."),
    },
    async (args, extra) => {
      const params = {
        categoryFilters: args.categoryFilters ?? null,
        selectedElementsOnly: args.selectedElementsOnly ?? false,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_material_quantities", params);
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
              text: `Get material quantities failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
