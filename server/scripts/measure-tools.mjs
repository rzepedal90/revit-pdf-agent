// Measures the byte size of tool names + descriptions + JSON schemas sent to the model.
// Usage: node scripts/measure-tools.mjs  (after `npm run build`; honours REVIT_MCP_PROFILE / REVIT_MCP_TOOLS)
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerTools } from "../build/tools/register.js";

const defs = [];
const fake = {
  tool(name, ...rest) {
    let desc = "";
    if (typeof rest[0] === "string") desc = rest.shift();
    const shape = rest.length > 1 && typeof rest[0] === "object" ? rest[0] : {};
    const schema = zodToJsonSchema(z.object(shape), { strictUnions: true });
    defs.push({ name, description: desc, inputSchema: schema });
  },
};
await registerTools(fake);
const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
const total = bytes(defs);
console.log(
  JSON.stringify({
    tools: defs.length,
    totalBytes: total,
    approxTokens: Math.round(total / 3.8),
    perTool: Object.fromEntries(defs.map((d) => [d.name, bytes(d)])),
  })
);
