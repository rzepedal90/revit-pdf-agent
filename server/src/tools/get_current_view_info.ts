import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerGetCurrentViewInfoTool(server: McpServer) {
  server.tool(
    "get_current_view_info",
    "Get details of the active Revit view: type, name, scale and other properties.",
    {},
    async (args, extra) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_current_view_info", {});
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
              text: `get current view info failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
