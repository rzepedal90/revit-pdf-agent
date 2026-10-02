import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveProfile } from "./profiles.js";

// Files in this directory that are not tool modules.
const NON_TOOL_FILES = new Set(["index", "register", "profiles"]);

export async function registerTools(server: McpServer) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const { allowed, warnings, label } = resolveProfile(process.env);
  for (const w of warnings) console.error(`[profile] warning: ${w}`);

  // Wrap the server so tools outside the active profile are never registered.
  const enabled: string[] = [];
  const skipped: string[] = [];
  const filtered = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (name: string, ...rest: unknown[]) => {
          if (allowed && !allowed.has(name)) {
            skipped.push(name);
            return undefined;
          }
          enabled.push(name);
          return (target.tool as (...a: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;

  const toolFiles = fs.readdirSync(__dirname).filter((file) => {
    if (!/\.(ts|js)$/.test(file) || file.endsWith(".d.ts")) return false;
    return !NON_TOOL_FILES.has(file.replace(/\.(ts|js)$/, ""));
  });

  for (const file of toolFiles) {
    try {
      const module = await import(`./${file.replace(/\.(ts|js)$/, ".js")}`);
      const registerFunctionName = Object.keys(module).find(
        (key) => key.startsWith("register") && typeof module[key] === "function"
      );
      if (registerFunctionName) {
        module[registerFunctionName](filtered);
      } else if (Object.keys(module).length > 0) {
        console.error(`Warning: no register function found in ${file}`);
      }
    } catch (error) {
      console.error(`Error registering tools from ${file}:`, error);
    }
  }

  if (allowed) {
    const missing = [...allowed].filter((t) => !enabled.includes(t));
    if (missing.length) console.error(`[profile] not available (no such tool module yet): ${missing.join(", ")}`);
  }
  console.error(`[profile] ${label}: enabled ${enabled.length} tools: ${enabled.join(", ")}`);
  if (skipped.length) console.error(`[profile] skipped ${skipped.length}: ${skipped.join(", ")}`);
}
