import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

const point = z.object({ x: z.number(), y: z.number(), z: z.number() });
const box = z.object({ p0: point, p1: point });

export function registerAIElementFilterTool(server: McpServer) {
  server.tool(
    "ai_element_filter",
    "Query Revit elements by category, element type, family symbol, view visibility or bounding box (mm). Returns detailed element data; filter further client-side (e.g. walls taller than 5 m).",
    {
      data: z
        .object({
          filterCategory: z
            .string()
            .optional()
            .describe("BuiltInCategory, e.g. OST_Walls, OST_Floors, OST_GenericModel (furniture may be OST_Furniture or OST_GenericModel)"),
          filterElementType: z
            .string()
            .optional()
            .describe("Element class/type name, e.g. 'Wall' or 'Autodesk.Revit.DB.Wall'"),
          filterFamilySymbolId: z
            .number()
            .optional()
            .describe("FamilySymbol ElementId to filter by; -1 for none"),
          includeTypes: z.boolean().default(false).describe("Include element types"),
          includeInstances: z.boolean().default(true).describe("Include element instances"),
          filterVisibleInCurrentView: z
            .boolean()
            .optional()
            .describe("Only elements visible in the current view (instances only)"),
          boundingBoxMin: box.optional().describe("Bounding box min (mm); used with boundingBoxMax to return intersecting elements"),
          boundingBoxMax: box.optional().describe("Bounding box max (mm)"),
          maxElements: z.number().optional().describe("Max elements per call (default 50; higher not recommended)"),
        })
        .describe("Filter criteria; all combined. Coordinates in mm."),
    },
    async (args, extra) => {
      const params = args;

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "ai_element_filter",
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
              text: `Get element information failed: ${error instanceof Error ? error.message : String(error)
                }`,
            },
          ],
        };
      }
    }
  );
}
