// =============================================================================
// turnGuard.ts  —  empty-turn retry policy (no vscode dependency)
// =============================================================================
//
// DeepSeek-family models on some gateways (e.g. `opencode-go` / Console Go)
// intermittently end a turn with reasoning content but no final text, no tool
// calls, and sometimes no finish reason at all. Copilot then marks the request
// (often a subagent) as "complete with no output". This module encodes the
// retry policy used to mask that: a turn that produced no text and no tool
// calls is retried once before we fall back to a minimal text part.

export interface TurnOutcome {
  /** Whether the model turn produced any text part. */
  hasText: boolean;
  /** Whether the model turn produced any tool call. */
  hasToolCall: boolean;
}

/**
 * Maximum number of model attempts per request: 1 initial turn plus one retry
 * when the turn ends empty (no text and no tool calls).
 */
export const MAX_TURNS = 2;

/** A turn is "empty" when it produced neither text nor tool calls. */
export function isEmptyTurn(outcome: TurnOutcome): boolean {
  return !outcome.hasText && !outcome.hasToolCall;
}

/**
 * Text reported when every attempt ended empty, so Copilot never shows
 * "complete with no output" for a request the model really answered nothing to.
 */
export const EMPTY_TURN_FALLBACK_TEXT =
  '(model returned an empty response after retry)';

/**
 * Execute `runAttempt` up to `MAX_TURNS` times, retrying only when a turn is
 * empty. Non-empty turns and thrown errors end the loop immediately. Returns
 * the last outcome and how many attempts were used.
 */
export async function runWithEmptyTurnRetry<T extends TurnOutcome>(
  runAttempt: (attempt: number) => Promise<T>,
  onRetry?: (attempt: number) => void,
): Promise<{ result: T; attempts: number }> {
  for (let attempt = 1; attempt <= MAX_TURNS; attempt++) {
    const result = await runAttempt(attempt);
    if (attempt < MAX_TURNS && isEmptyTurn(result)) {
      onRetry?.(attempt);
      continue;
    }
    return { result, attempts: attempt };
  }
  throw new Error('unreachable');
}