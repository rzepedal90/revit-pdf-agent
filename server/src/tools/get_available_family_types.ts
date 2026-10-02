import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerGetAvailableFamilyTypesTool(server: McpServer) {
  server.tool(
    "get_available_family_types",
    "List family types in the project; filter by category and family name.",
    {
      categoryList: z
        .array(z.string())
        .optional()
        .describe(
          "List of Revit category names to filter by (e.g., 'OST_Walls', 'OST_Doors', 'OST_Furniture')"
        ),
      familyNameFilter: z
        .string()
        .optional()
        .describe("Filter family types by family name (partial match)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of family types to return"),
    },
    async (args, extra) => {
      const params = {
        categoryList: args.categoryList || [],
        familyNameFilter: args.familyNameFilter || "",
        limit: args.limit || 100,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "get_available_family_types",
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
              text: `get available family types failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
