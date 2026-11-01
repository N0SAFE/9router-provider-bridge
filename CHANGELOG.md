# Changelog

## Unreleased

- Per-model configuration: expose the request parameters 9Router publishes per
  model as a VS Code configuration schema (reasoning effort, temperature,
  top_p, top_k, max_tokens, frequency/presence penalties, seed) and forward the
  resolved `modelConfiguration` to the upstream request.
- Reasoning effort uses VS Code's BYOK property name `reasoningEffort` so the
  agent-host BYOK bridge publishes it as a session thinking level; the resolver
  also accepts `thinkingLevel` and the legacy `reasoning_effort` key.
- Model labels fall back to the model id / provider alias when the catalog has
  no display name, so picker rows never render without a name.
- Provider models no longer set an inline `detail`: VS Code lays the picker row
  out with the label at `flex: 1` and the description taking its content width
  first, so the long pool summary squeezed the label to zero width and rows
  looked nameless. Pool health remains in the hover tooltip.

## 0.1.0

- Initial release.
- Discovery via 9Router `/v1/bridge` (fallback: `/v1/models` + `/v1/pools`).
- Group modes: `all`, `providers`, `combos`, `pools`.
- Provider models with capabilities, context limits and pool health tooltips.
- Combos as selectable models with limits resolved from member models.
- Pool status entries, status bar, `Show Pools` quick pick.
- OpenAI-compatible chat streaming with thinking, tool calls and usage.
- Optional API key, per-group baseUrl, `chatLanguageModels.json` recovery.
