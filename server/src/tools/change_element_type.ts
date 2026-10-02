import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";

export function registerChangeElementTypeTool(server: McpServer) {
  server.tool(
    "change_element_type",
    "Change the type of one or more elements to typeId after checking category and valid-type compatibility; reads each element's type back and rolls everything back on mismatch. Returns {ok,typeId,typeName,count,changed,items:[{elementId,oldTypeId,newTypeId}]} or {ok:false,error:{code,message}}.",
    {
      ids: z.array(z.union([z.number(), z.string()])).min(1).describe("Element ids to retype"),
      typeId: z.union([z.number(), z.string()]).describe("Target type element id"),
      expectedCount: z
        .number()
        .int()
        .optional()
        .describe("Optional guard: fail with identity_conflict before writing if the number of ids differs"),
    },
    async (args) => runTypedCommand("change_element_type", args)
  );
}
