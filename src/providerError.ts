// =============================================================================
// providerError.ts  —  upstream error message extraction (no vscode dependency)
// =============================================================================

/**
 * Extract a readable, single-line message from an upstream error body like
 * `{"type":"error","error":{"type":"AuthError","message":"Request blocked by
 * upstream provider."}}` or a plain message string, with surrounding JSON
 * structure stripped. Used so users see the real cause (e.g. a per-model usage
 * allowance being exhausted) instead of a blanket classification.
 */
export function cleanUpstreamMessage(raw: string | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) {return 'request rejected by provider';}

  try {
    const parsed = JSON.parse(text);
    const deep = (value: unknown): string => {
      if (typeof value === 'string') {return value;}
      if (Array.isArray(value)) {return value.map(deep).join(' ');}
      if (value && typeof value === 'object') {
        for (const k of ['message', 'error', 'type']) {
          const v = (value as Record<string, unknown>)[k];
          const found = deep(v);
          if (found) {return found;}
        }
      }
      return '';
    };
    const extracted = deep(parsed).trim();
    if (extracted) {return extracted.slice(0, 300);}
  } catch { /* not JSON — fall through to plain text */ }

  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}