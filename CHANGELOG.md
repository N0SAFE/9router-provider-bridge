# Changelog

## 0.1.0

- Initial release.
- Discovery via 9Router `/v1/bridge` (fallback: `/v1/models` + `/v1/pools`).
- Group modes: `all`, `providers`, `combos`, `pools`.
- Provider models with capabilities, context limits and pool health tooltips.
- Combos as selectable models with limits resolved from member models.
- Pool status entries, status bar, `Show Pools` quick pick.
- OpenAI-compatible chat streaming with thinking, tool calls and usage.
- Optional API key, per-group baseUrl, `chatLanguageModels.json` recovery.
