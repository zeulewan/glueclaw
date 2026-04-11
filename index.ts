import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeCliStreamFn } from "./src/stream.js";
import { MODEL_CATALOG } from "./src/catalog.js";

const PROVIDER_ID = "glueclaw";
const PROVIDER_LABEL = "GlueClaw";
const BASE_URL = "local://glueclaw";
const API_FORMAT = "anthropic-messages";
const AUTH_KEY = "glueclaw-local";
const AUTH_SOURCE = "claude CLI (local auth)";

const MODEL_MAP: Readonly<Record<string, string>> = {
  "glueclaw-opus": "claude-opus-4-6",
  "glueclaw-sonnet": "claude-sonnet-4-6",
  "glueclaw-haiku": "claude-haiku-4-5",
};

export default definePluginEntry({
  register(api: OpenClawPluginApi): void {
    const authProfile = () =>
      ({
        apiKey: AUTH_KEY,
        source: AUTH_SOURCE,
        mode: "api-key" as const,
      }) as const;

    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      aliases: ["sc"],
      envVars: ["GLUECLAW_KEY"],
      auth: [
        {
          method: "local",
          label: "Local Claude CLI",
          hint: "Uses your locally installed claude binary",
          authenticate: async () => authProfile(),
          authenticateNonInteractive: async () => authProfile(),
        },
      ],
      catalog: {
        run: async () => ({
          provider: {
            baseUrl: BASE_URL,
            api: API_FORMAT,
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
                contextWindow: 1_000_000,
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
        const realModel = MODEL_MAP[ctx.modelId] ?? ctx.modelId;
        return createClaudeCliStreamFn({
          sessionKey: ctx.agentDir ?? "default",
          modelOverride: realModel,
        });
      },
      resolveSyntheticAuth: () => ({
        apiKey: AUTH_KEY,
        source: AUTH_SOURCE,
        mode: "api-key",
      }),
      augmentModelCatalog: () => [...MODEL_CATALOG],
    });
  },
});
