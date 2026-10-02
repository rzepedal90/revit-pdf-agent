import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerCreateStructuralFramingSystemTool(server: McpServer) {
  server.tool(
    "create_structural_framing_system",
    "Create a beam system in a rectangular boundary at fixed spacing (Revit BeamSystem). mm.",
    {
      levelName: z
        .string()
        .describe(
          "Level name; a missing 'Level N' is auto-created (4000 mm story height)"
        ),
      xMin: z
        .number()
        .describe("Boundary Minimum X (mm)"),
      xMax: z
        .number()
        .describe("Boundary Maximum X (mm)"),
      yMin: z
        .number()
        .describe("Boundary Minimum Y (mm)"),
      yMax: z
        .number()
        .describe("Boundary Maximum Y (mm)"),
      spacing: z
        .number()
        .positive()
        .describe("Spacing between beams in millimeters"),
      directionEdge: z
        .enum(["bottom", "right", "top", "left"])
        .default("bottom")
        .describe(
          "Beams run perpendicular to this edge (bottom/top = Y direction, left/right = X)"
        ),
      layoutRule: z
        .enum(["fixed_distance"])
        .default("fixed_distance")
        .describe(
          "Only fixed_distance"
        ),
      justify: z
        .enum(["beginning", "center", "end", "directionline"])
        .default("center")
        .describe(
          "Beam justification"
        ),
      beamTypeName: z
        .string()
        .optional()
        .describe(
          "Beam type name (default: first structural framing type)"
        ),
      elevation: z
        .number()
        .default(0)
        .describe(
          "Offset from level (mm)"
        ),
      is3d: z
        .boolean()
        .default(false)
        .describe(
          "3D system for sloped/non-planar layouts"
        ),
    },
    async (args, extra) => {
      const params = {
        levelName: args.levelName,
        xMin: args.xMin,
        xMax: args.xMax,
        yMin: args.yMin,
        yMax: args.yMax,
        spacing: args.spacing,
        directionEdge: args.directionEdge,
        layoutRule: args.layoutRule,
        justify: args.justify,
        beamTypeName: args.beamTypeName,
        elevation: args.elevation,
        is3d: args.is3d,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "create_structural_framing_system",
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
              text: `Create structural framing system failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
