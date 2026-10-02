import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

const transactionModeSchema = z
  .enum(["auto", "none"])
  .default("auto")
  .describe(
    "'auto' wraps the code in a transaction; 'none' if it manages its own"
  );

export function registerSendCodeToRevitTool(server: McpServer) {
  server.tool(
    "send_code_to_revit",
    "Run C# in Revit. The code is inserted into a template Execute method with Document and parameters in scope.",
    {
      code: z
        .string()
        .describe(
          "C# body for the Execute method"
        ),
      parameters: z
        .array(z.string())
        .optional()
        .describe(
          "Parameters passed to the code"
        ),
      transactionMode: transactionModeSchema,
    },
    async (args, extra) => {
      const params = {
        code: args.code,
        parameters: args.parameters || [],
        transactionMode: args.transactionMode,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("send_code_to_revit", params);
        });

        return {
          content: [
            {
              type: "text",
              text: `Code execution successful!\nResult: ${toText(response)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Code execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
