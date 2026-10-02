import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerOperateElementTool(server: McpServer) {
  server.tool(
    "operate_element",
    "Apply an action to Revit elements by id: select, set color/transparency, hide, isolate, delete, etc.",
    {
      data: z
        .object({
          elementIds: z.array(z.number()).describe("Element ids to act on"),
          action: z
            .string()
            .describe("One of: Select, SelectionBox, SetColor (uses colorValue), SetTransparency (uses transparencyValue), Delete (permanent), Hide, TempHide, Isolate, Unhide, ResetIsolate, Highlight (red)"),
          transparencyValue: z.number().default(50).describe("0-100 for SetTransparency"),
          colorValue: z.array(z.number()).default([255, 0, 0]).describe("RGB for SetColor")
        }),
    },
    async (args, extra) => {
      const params = args;

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "operate_element",
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
              text: `Operate elements failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
