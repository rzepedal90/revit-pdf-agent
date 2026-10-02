import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerTagAllRoomsTool(server: McpServer) {
  server.tool(
    "tag_all_rooms",
    "Tag all rooms in the active view at their centers (name and number).",
    {
      useLeader: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to use a leader line when creating the tags"),
      tagTypeId: z
        .string()
        .optional()
        .describe("The ID of the specific room tag family type to use. If not provided, the default room tag type will be used"),
      roomIds: z
        .array(z.number())
        .optional()
        .describe("Optional array of specific room element IDs to tag. If not provided, all rooms in the current view will be tagged"),
    },
    async (args, extra) => {
      const params = args;
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("tag_rooms", params);
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
              text: `Room tagging failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
