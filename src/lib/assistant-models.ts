export type AssistantProvider = "openai" | "anthropic" | "google" | "xai";

export interface AssistantModelOption {
  id: string;
  label: string;
  provider: AssistantProvider;
  providerLabel: string;
  requiredEnvVar: string;
}

export const ASSISTANT_MODEL_OPTIONS: AssistantModelOption[] = [
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    provider: "openai",
    providerLabel: "OpenAI",
    requiredEnvVar: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.2-pro",
    label: "GPT-5.2 Pro",
    provider: "openai",
    providerLabel: "OpenAI",
    requiredEnvVar: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    provider: "openai",
    providerLabel: "OpenAI",
    requiredEnvVar: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    provider: "openai",
    providerLabel: "OpenAI",
    requiredEnvVar: "OPENAI_API_KEY",
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    provider: "anthropic",
    providerLabel: "Anthropic",
    requiredEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    providerLabel: "Anthropic",
    requiredEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    providerLabel: "Anthropic",
    requiredEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "google",
    providerLabel: "Google",
    requiredEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash-Lite (Preview)",
    provider: "google",
    providerLabel: "Google",
    requiredEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    providerLabel: "Google",
    requiredEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    providerLabel: "Google",
    requiredEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "grok-4-1-fast-reasoning",
    label: "Grok 4.1 Fast Reasoning",
    provider: "xai",
    providerLabel: "xAI",
    requiredEnvVar: "XAI_API_KEY",
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    label: "Grok 4.1 Fast Non-Reasoning",
    provider: "xai",
    providerLabel: "xAI",
    requiredEnvVar: "XAI_API_KEY",
  },
  {
    id: "grok-4-fast-reasoning",
    label: "Grok 4 Fast Reasoning",
    provider: "xai",
    providerLabel: "xAI",
    requiredEnvVar: "XAI_API_KEY",
  },
  {
    id: "grok-4-fast-non-reasoning",
    label: "Grok 4 Fast Non-Reasoning",
    provider: "xai",
    providerLabel: "xAI",
    requiredEnvVar: "XAI_API_KEY",
  },
];

export const DEFAULT_ASSISTANT_MODEL_ID = "gpt-5.2";

export function getAssistantModelOption(
  modelId: string,
): AssistantModelOption | null {
  return ASSISTANT_MODEL_OPTIONS.find((model) => model.id === modelId) ?? null;
}

export function getMissingProviderKeyMessage(
  model: AssistantModelOption,
): string {
  return `${model.providerLabel} requires ${model.requiredEnvVar} in your environment.`;
}
