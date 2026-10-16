import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toText } from "../utils/toolResult.js";

export function registerGetCadGeometryTool(server: McpServer) {
  server.tool(
    "get_cad_geometry",
    "Read-only. Extracts exact geometry from imported CAD (ImportInstance, e.g. a DWG floor plan) per CAD layer, in model coordinates (mm). mode 'layers' lists layers per import (counts by kind, bbox, color/weight/pattern, visibility in viewId) plus import info (transform, pinned, extents); mode 'geometry' returns lines {k:'l',a,b}, arcs {k:'a',c,r,start,end}, polylines {k:'p',pts,closed,bbox,centroid,area} and solids {k:'s',bbox,volume} for the selected layers. Imports can hold ~10k objects: always filter (layers, bboxMm, kinds, simplify) and page (limit/offset), or pass outFile (absolute path) to write the full JSON to disk and get only a summary back.",
    {
      importId: z.number().int().optional().describe("ImportInstance id. Default: all imports (mode 'geometry' with several imports requires it)."),
      mode: z.enum(["layers", "geometry"]).describe("'layers' = layer summary; 'geometry' = objects."),
      layers: z
        .array(z.string())
        .optional()
        .describe("Layer filters, case-insensitive: exact, suffix on a '$' boundary ('0-PILARES' matches 'Xref N1$0$0-PILARES'), or '*' wildcard. Default: all layers."),
      viewId: z
        .number()
        .int()
        .optional()
        .describe("Use view-specific geometry and report per-layer visibility in this view."),
      bboxMm: z
        .object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() })
        .optional()
        .describe("Only objects intersecting this model XY rectangle (mm)."),
      kinds: z.array(z.enum(["line", "arc", "polyline", "solid"])).optional().describe("Restrict object kinds."),
      simplify: z
        .object({ minLengthMm: z.number().min(0).optional() })
        .optional()
        .describe("Drop objects shorter than minLengthMm."),
      limit: z.number().int().min(1).max(20000).default(2000).describe("Page size (default 2000, max 20000)."),
      offset: z.number().int().min(0).default(0).describe("Page offset."),
      outFile: z
        .string()
        .optional()
        .describe("Absolute path: write the full (unpaged) JSON there and return only {total,file,layersSummary}."),
    },
    async (args) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_cad_geometry", args);
        });
        return { content: [{ type: "text", text: toText(response) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `get_cad_geometry failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
