const PROVIDER_ID = "glueclaw";

export const MODEL_CATALOG = [
  {
    id: "glueclaw-opus",
    name: "GlueClaw Opus",
    provider: PROVIDER_ID,
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text"],
  },
  {
    id: "glueclaw-sonnet",
    name: "GlueClaw Sonnet",
    provider: PROVIDER_ID,
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text"],
  },
  {
    id: "glueclaw-haiku",
    name: "GlueClaw Haiku",
    provider: PROVIDER_ID,
    contextWindow: 200_000,
    reasoning: false,
    input: ["text"],
  },
] as const;
