// Shared helpers for tool results: compact JSON and bounded text size.

export type ToolTextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_MAX_TEXT = 60000;

/** Max characters of a single text result. Env REVIT_MCP_MAX_TEXT (0 = unlimited). */
export function getMaxText(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REVIT_MCP_MAX_TEXT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_TEXT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_TEXT;
}

/** Truncates text above `max` chars with an explicit marker. */
export function truncateText(text: string, max: number = getMaxText()): string {
  if (max <= 0 || text.length <= max) return text;
  const dropped = text.length - max;
  return (
    text.slice(0, max) +
    `\n…truncated ${dropped} chars. Result too large: narrow the query (filters, fewer ids/fields) or page with limit/offset.`
  );
}

/** Compact (non-pretty) JSON, truncated if very large. */
export function toText(value: unknown): string {
  return truncateText(JSON.stringify(value) ?? "null");
}

export function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text: truncateText(text) }] };
}

export function jsonResult(value: unknown): ToolTextResult {
  return { content: [{ type: "text", text: toText(value) }] };
}

export function errorResult(prefix: string, error: unknown): ToolTextResult {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `${prefix}: ${msg}` }] };
}
