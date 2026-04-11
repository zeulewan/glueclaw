import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeCliStreamFn } from "./src/stream.js";

const PROVIDER_ID = "glueclaw";

export default definePluginEntry({
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "GlueClaw",
      aliases: ["sc"],
      envVars: ["GLUECLAW_KEY"],
      auth: [
        {
          method: "local",
          label: "Local Claude CLI",
          hint: "Uses your locally installed claude binary",
          authenticate: async () => ({
            apiKey: "glueclaw-local",
            source: "claude CLI (local auth)",
            mode: "api-key" as const,
          }),
          authenticateNonInteractive: async () => ({
            apiKey: "glueclaw-local",
            source: "claude CLI (local auth)",
            mode: "api-key" as const,
          }),
        },
      ],
      catalog: {
        run: async () => ({
          provider: {
            baseUrl: "local://glueclaw",
            api: "anthropic-messages",
            models: [
              {
                id: "glueclaw-opus",
                name: "GlueClaw Opus",
                contextWindow: 1_000_000,
                maxTokens: 32_000,
              },
              {
                id: "glueclaw-sonnet",
                name: "GlueClaw Sonnet",
                contextWindow: 200_000,
                maxTokens: 16_000,
              },
              {
                id: "glueclaw-haiku",
                name: "GlueClaw Haiku",
                contextWindow: 200_000,
                maxTokens: 8_000,
              },
            ],
          },
        }),
      },
      createStreamFn: (ctx: { modelId: string; agentDir?: string }) => {
        // Map our friendly names to real claude model IDs
        const modelMap: Record<string, string> = {
          "glueclaw-opus": "claude-opus-4-6",
          "glueclaw-sonnet": "claude-sonnet-4-6",
          "glueclaw-haiku": "claude-haiku-4-5",
        };
        const realModel = modelMap[ctx.modelId] ?? ctx.modelId;
        return createClaudeCliStreamFn({
          sessionKey: ctx.agentDir ?? "default",
          modelOverride: realModel,
        });
      },
      resolveSyntheticAuth: () => ({
        apiKey: "glueclaw-local",
        source: "claude CLI (local auth)",
        mode: "api-key",
      }),
      augmentModelCatalog: () => [
        {
          id: "glueclaw-opus",
          name: "GlueClaw Opus",
          provider: PROVIDER_ID,
          contextWindow: 1_000_000,
          reasoning: true,
        },
        {
          id: "glueclaw-sonnet",
          name: "GlueClaw Sonnet",
          provider: PROVIDER_ID,
          contextWindow: 200_000,
          reasoning: true,
        },
        {
          id: "glueclaw-haiku",
          name: "GlueClaw Haiku",
          provider: PROVIDER_ID,
          contextWindow: 200_000,
        },
      ],
    });
  },
});
