import OpenAI from "openai";

/**
 * The only place the model provider is named.
 *
 * Groq serves open models behind an OpenAI-compatible endpoint, so the OpenAI
 * SDK is the right client here. qwen3.8-27b is the pick because it is the one
 * model on the free tier that does BOTH things this app needs — it reads
 * images and it calls tools. (gpt-oss-120b calls tools but rejects image
 * content outright; qwen3.6 sees images but spends its whole token budget
 * leaking <think> monologue.)
 *
 * To move to another provider, change these three constants and nothing else:
 * the tool definitions, the loop, and all the scoring are provider-agnostic.
 */
export const BASE_URL = "https://api.groq.com/openai/v1";
export const AGENT_MODEL = "qwen/qwen3.8-27b";
export const VISION_MODEL = "qwen/qwen3.8-27b";

export const hasCredentials = () => Boolean(process.env.GROQ_API_KEY);

export function createClient({ timeout = 18_000 } = {}) {
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: BASE_URL,
    timeout,
    // No retry: on a 429 the free tier asks for a ~12s wait, which would blow
    // the whole agent budget. Failing straight through to the deterministic
    // fallback gives the user an answer far sooner.
    maxRetries: 0,
  });
}
