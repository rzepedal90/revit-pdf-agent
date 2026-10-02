import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerCreateGridTool(server: McpServer) {
  server.tool(
    "create_grid",
    "Create a grid system: X and Y grid lines with spacing, extents and alphabetic/numeric naming. mm.",
    {
      xCount: z
        .number()
        .int()
        .positive()
        .describe("Count of X-axis (vertical) grids"),
      xSpacing: z
        .number()
        .positive()
        .describe("X grid spacing (mm)"),
      xStartLabel: z
        .string()
        .default("A")
        .describe("Starting label for X-axis grids (e.g., 'A' or '1')"),
      xNamingStyle: z
        .enum(["alphabetic", "numeric"])
        .default("alphabetic")
        .describe("alphabetic (A,B,C) or numeric (1,2,3)"),
      yCount: z
        .number()
        .int()
        .positive()
        .describe("Count of Y-axis (horizontal) grids"),
      ySpacing: z
        .number()
        .positive()
        .describe("Y grid spacing (mm)"),
      yStartLabel: z
        .string()
        .default("1")
        .describe("Starting label for Y-axis grids (e.g., '1' or 'A')"),
      yNamingStyle: z
        .enum(["alphabetic", "numeric"])
        .default("numeric")
        .describe("alphabetic (A,B,C) or numeric (1,2,3)"),
      xExtentMin: z
        .number()
        .default(0)
        .describe("X extent min (mm)"),
      xExtentMax: z
        .number()
        .default(50000)
        .describe("X extent max (mm)"),
      yExtentMin: z
        .number()
        .default(0)
        .describe("Y extent min (mm)"),
      yExtentMax: z
        .number()
        .default(50000)
        .describe("Y extent max (mm)"),
      elevation: z
        .number()
        .default(0)
        .describe("Elevation Z (mm)"),
      xStartPosition: z
        .number()
        .default(0)
        .describe("First X grid position (mm)"),
      yStartPosition: z
        .number()
        .default(0)
        .describe("First Y grid position (mm)"),
    },
    async (args, extra) => {
      const params = {
        xCount: args.xCount,
        xSpacing: args.xSpacing,
        xStartLabel: args.xStartLabel,
        xNamingStyle: args.xNamingStyle,
        yCount: args.yCount,
        ySpacing: args.ySpacing,
        yStartLabel: args.yStartLabel,
        yNamingStyle: args.yNamingStyle,
        xExtentMin: args.xExtentMin,
        xExtentMax: args.xExtentMax,
        yExtentMin: args.yExtentMin,
        yExtentMax: args.yExtentMax,
        elevation: args.elevation,
        xStartPosition: args.xStartPosition,
        yStartPosition: args.yStartPosition,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("create_grid", params);
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
              text: `Create grid failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
