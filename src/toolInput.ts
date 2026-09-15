// =============================================================================
// toolInput.ts  —  Tool call input normalization (no vscode dependency)
// =============================================================================

/**
 * Normalize a tool-call `input` into a JSON object.
 *
 * Copilot's language model protocol requires assistant tool-call
 * `function.arguments` to be a JSON *object*. The AI SDK can deliver a
 * tool-call input as a JSON *string* (e.g. when the upstream streamed the
 * arguments and they never became complete/parsable JSON before the stream
 * ended, or when the arguments parse to a non-object value). Reporting such a
 * string to Copilot makes it round-trip the value back, and re-serializing it
 * with `JSON.stringify` produces a double-encoded string that the upstream
 * rejects with `400 Assistant tool call function.arguments must be a JSON
 * object`. Always coerce to a plain object so both directions stay valid.
 */
export function normalizeToolCallInput(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) {
    return {};
  }
  if (typeof input === 'object') {
    return Array.isArray(input) ? {} : input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {return {};}
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Normalize a tool name so the upstream accepts it.
 *
 * OpenAI-compatible APIs (and OpenCode Go / Console Go) require tool function
 * names to be at most 64 characters and match `[a-zA-Z0-9_-]+`. VS Code tool
 * names come from any extension (MCP servers, agent tools, …) and can exceed
 * 64 characters or contain characters outside that set — passing them through
 * verbatim makes the upstream reject the whole request with e.g.
 * `name must be at most 64 characters, got 67`.
 *
 * Returns a name that satisfies the constraint. The caller keeps a
 * normalized→original map so tool calls can still be reported back to VS Code
 * under the original registered name.
 */
export function normalizeToolName(name: string): string {
  let n = String(name ?? '').trim();
  // OpenAI function-name charset: [a-zA-Z0-9_-]. Replace anything else so
  // names like "github.pullRequest" or "server/tool" don't get rejected.
  n = n.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Hard 64-char limit enforced by openai-compatible gateways.
  if (n.length > 64) {
    n = n.slice(0, 64);
  }
  return n || 'tool';
}