import { withRevitConnection } from "./ConnectionManager.js";

// Typed-error helper for the verified-write tools. The C# command set throws
// RevitCommandException whose message is "[code] detail"; the transport only
// forwards the message, so the code is parsed back out here.

type ToolResult = { content: { type: "text"; text: string }[] };

const KNOWN_CODES = new Set([
  "invalid_parameter",
  "not_found",
  "name_collision",
  "identity_conflict",
  "unit_unsupported",
  "readback_mismatch",
  "revit_error",
]);

export function parseTypedError(message: string): { code: string; message: string } {
  const m = /^(?:.*?)\[([a-z_]+)\]\s*([\s\S]*)$/.exec(message);
  if (m && KNOWN_CODES.has(m[1])) return { code: m[1], message: m[2] };
  return { code: "revit_error", message };
}

/** Sends a command and returns compact JSON: the command result, or {ok:false,error:{code,message}}. */
export async function runTypedCommand(command: string, params: unknown): Promise<ToolResult> {
  try {
    const response = await withRevitConnection(async (revitClient) =>
      revitClient.sendCommand(command, params)
    );
    const body =
      response && typeof response === "object" && "ok" in response
        ? response
        : { ok: true, result: response };
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: parseTypedError(msg) }) }],
    };
  }
}
