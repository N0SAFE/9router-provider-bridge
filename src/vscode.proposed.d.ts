// =============================================================================
// vscode.proposed.d.ts  —  Augmentations for proposed VS Code APIs
// =============================================================================
//
// `isUserSelectable` on LanguageModelChatInformation is available in
// the VS Code 1.120 runtime but not yet published in @types/vscode.
//
// `configuration` / `modelConfiguration` belong to the proposed `chatProvider`
// API (vscode.proposed.chatProvider.d.ts). The 1.120 runtime already passes
// them to language model chat providers:
//
//   - PrepareLanguageModelChatModelOptions.configuration
//       Per-group configuration resolved from the user's chatLanguageModels.json
//       (e.g. { name, vendor, apiKey }). Passed to
//       provideLanguageModelChatInformation once per configured group — this is
//       how multiple provider instances (each with its own API key) are managed.
//   - ProvideLanguageModelChatResponseOptions.modelConfiguration
//       The resolved per-model configuration, passed to
//       provideLanguageModelChatResponse.
//   - LanguageModelChatInformation.configuration
//       The configuration a provider attaches to each returned model so it
//       round-trips back into provideLanguageModelChatResponse (mirrors the
//       built-in Copilot BYOK providers' ExtendedLanguageModelChatInformation).
//
// See https://github.com/microsoft/vscode/tree/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts
// =============================================================================

export {};

declare module 'vscode' {
  interface LanguageModelChatInformation {
    /**
     * When `true`, the model appears in the chat model picker.
     * When `false` or omitted, the model is hidden from the picker
     * but still visible in the full Language Models dialog.
     */
    readonly isUserSelectable?: boolean;

    /**
     * Per-group configuration (from chatLanguageModels.json) attached by the
     * provider to each model. Round-trips into provideLanguageModelChatResponse.
     */
    readonly configuration?: {
      readonly [key: string]: any;
    };
  }

  interface PrepareLanguageModelChatModelOptions {
    /**
     * Configuration for the model. Only present when the provider has declared
     * that it requires configuration via the `configuration` property of its
     * `languageModelChatProviders` contribution. One object per group entry in
     * chatLanguageModels.json (e.g. `{ name, vendor, apiKey }`).
     */
    readonly configuration?: {
      readonly [key: string]: any;
    };
  }

  interface ProvideLanguageModelChatResponseOptions {
    /**
     * Per-model configuration provided by the user. Contains values configured
     * in chatLanguageModels.json, validated against the model's configuration
     * schema. The `apiKey` for the provider group is available here.
     */
    readonly modelConfiguration?: {
      readonly [key: string]: any;
    };
  }
}
