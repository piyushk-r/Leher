import OpenAI from "openai";

/**
 * The only place the model provider is named.
 *
 * Groq serves open models behind an OpenAI-compatible endpoint, so the OpenAI
 * SDK is the right client here.
 *
 * Two different models on purpose, and it is a rate-limit decision rather than
 * a capability one. Groq's free tier meters input tokens PER MODEL, at 7000
 * per minute each. One vision call costs ~4400 against that budget and the
 * agent loop another ~3400, so running both on one model puts every single
 * run over the limit — no image size fixes it, because the image is tiled to a
 * fixed token count regardless of how small you send it.
 *
 * Splitting them gives each its own 7000. It costs nothing architecturally:
 * the orchestrator is text-only by design and never sees the photo, so it does
 * not need a vision model at all.
 *
 *   qwen3.8-27b   — the only free-tier model that reads images AND calls tools
 *   gpt-oss-120b  — text-only, strong tool calling, its own separate budget
 *
 * To move provider, change these constants and nothing else: the tools, the
 * loop and all the scoring are provider-agnostic.
 */
export const BASE_URL = "https://api.groq.com/openai/v1";
export const AGENT_MODEL = "openai/gpt-oss-120b";
export const VISION_MODEL = "qwen/qwen3.8-27b";

// The two models disagree on what this parameter accepts: qwen takes "none",
// gpt-oss rejects anything outside low/medium/high with a 400.
export const AGENT_REASONING = "low";
export const VISION_REASONING = "none";

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
