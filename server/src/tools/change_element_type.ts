import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTypedCommand } from "../utils/typedResult.js";

export function registerChangeElementTypeTool(server: McpServer) {
  server.tool(
    "change_element_type",
    "Change elements to type typeId (category-checked, read back, rolled back on mismatch). Returns {ok,count,changed,items} or {ok:false,error}.",
    {
      ids: z.array(z.union([z.number(), z.string()])).min(1).describe("Element ids to retype"),
      typeId: z.union([z.number(), z.string()]).describe("Target type element id"),
      expectedCount: z
        .number()
        .int()
        .optional()
        .describe("Fail with identity_conflict if ids.length differs"),
    },
    async (args) => runTypedCommand("change_element_type", args)
  );
}
