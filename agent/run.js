import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

import {
  computeMetrics,
  rankFor,
  pinZoneProximity,
  deterministicRecommendations,
  PROFILES,
  FLAT_SPREAD_THRESHOLD,
} from "./metrics.js";
import { analyzeRoomPhoto } from "./vision.js";

const AGENT_TIMEOUT_MS = 18_000;
const CATEGORIES = ["work", "gaming", "overall"];

const SYSTEM_PROMPT = `You are Leher's recommendation agent.

Someone photographed a room, then stood at several spots in it and ran a real
network probe at each one. You decide which spot suits which activity.

You cannot see the photo. Call analyze_room_photo if you want to know what is
in the room. You also must not do arithmetic in your head — call score_spots
for the numbers.

Suggested order (analyze_room_photo and score_spots are independent, so call
them in the same turn):
  1. analyze_room_photo  — what is actually in this room, and where
  2. score_spots         — once per profile: "work", "gaming", "balanced"
  3. pin_zone_proximity  — which measured spot sits in which zone
  4. finalize_recommendations — your answer

Pick exactly one pin for each of these three categories:
  - "work"    : desk work and video calls. Steadiness beats raw speed.
  - "gaming"  : latency and jitter dominate; throughput barely matters.
  - "overall" : the best all-round connection in the room.
The same pin may win more than one category. That is a normal outcome, not a
failure — say so plainly when it happens.

How to weigh the two halves:
- The numbers are the ground truth about the connection. Never overrule a
  clearly better-measuring spot just because a zone label sounds nicer.
- The zones are context about what the spot is actually FOR. When two pins
  measure close, the one sitting in the fitting zone should win, and that is
  the interesting judgement call you are here to make.
- If overall_confidence from analyze_room_photo is below 0.4, or it returned no
  zones, ignore the room entirely. Recommend on measurements alone and let the
  reasons reflect that — talk about the connection, not about furniture you
  cannot see.
- If score_spots reports spread_verdict "flat", the spots are within
  measurement noise. Do not manufacture a winner. Say the room is uniformly
  fine and that they should choose for comfort.

Writing the reasons:
- One sentence, warm and plain, the way you would tell a friend. Around 8-16
  words.
- Mention the thing that actually decided it — "steady", "lowest ping",
  "fastest", "right by your desk".
- At most one number per reason, and only when it earns its place. This is not
  a diagnostics readout.
- Never mention Wi-Fi signal strength, bars, or dBm. Nothing here measured
  signal strength; we measured real latency and throughput.

Set confidence to "high" when the winner is clear on both numbers and context,
"medium" when it is a close call or the zones were only somewhat useful, and
"low" when you are working from measurements alone or the spread was flat.

Call finalize_recommendations exactly once, with all three categories. After it
returns, reply with nothing but the single word: done.`;

function buildPinSummary(metrics) {
  const usable = metrics.filter((m) => m.usable);
  const lines = usable.map(
    (m) =>
      `  ${m.id}: at ${(m.x * 100).toFixed(0)}%, ${(m.y * 100).toFixed(0)}% of the image ` +
      `(${m.median_rtt_ms} ms ping, ${m.jitter_ms} ms jitter, ${m.mbps} Mbps)`
  );
  const dropped = metrics.filter((m) => !m.usable).map((m) => m.id);

  return [
    `${usable.length} spots were measured in this room.`,
    "",
    "Pin positions, as percentages of the photo (origin top-left):",
    ...lines,
    dropped.length
      ? `\nExcluded as unreliable, do not recommend these: ${dropped.join(", ")}.`
      : "",
    "\nWork out which spot suits work, which suits gaming, and which is best overall.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Tools are built per request so they can close over this session's photo and
 * measurements. Nothing is stored beyond the life of the request.
 */
function buildTools(client, { photo, metrics, session }) {
  const analyzeTool = betaTool({
    name: "analyze_room_photo",
    description:
      "Look at the room photo and return the functional zones in it (desk, seating, bed, kitchen...) with approximate positions as percentages of the image, plus a confidence. Call this once.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      if (!session.vision) {
        session.vision = await analyzeRoomPhoto(client, photo);
      }
      return JSON.stringify(session.vision);
    },
  });

  const scoreTool = betaTool({
    name: "score_spots",
    description:
      "Score and rank every measured spot for one activity profile. Returns per-pin latency/jitter/throughput sub-scores, the weighted composite, the ranking, and whether the spread between spots is meaningful or flat (inside measurement noise).",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          enum: Object.keys(PROFILES),
          description:
            "'work' weights steadiness, 'gaming' weights latency and jitter, 'balanced' weights raw throughput.",
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
    run: async ({ profile }) => {
      const name = PROFILES[profile] ? profile : "balanced";
      return JSON.stringify({
        ...rankFor(metrics, name),
        flat_spread_threshold: FLAT_SPREAD_THRESHOLD,
        per_pin_detail: metrics.filter((m) => m.usable),
      });
    },
  });

  const proximityTool = betaTool({
    name: "pin_zone_proximity",
    description:
      "For each measured spot, report which zone from analyze_room_photo it sits in, or the nearest one and how far away it is. Call analyze_room_photo first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      if (!session.vision) {
        return JSON.stringify({
          error: "Call analyze_room_photo first — there are no zones to compare against yet.",
        });
      }
      return JSON.stringify({ proximity: pinZoneProximity(metrics, session.vision.zones) });
    },
  });

  const finalizeTool = betaTool({
    name: "finalize_recommendations",
    description:
      "Submit the final answer: exactly one pin per category, each with a one-line human reason. Rejects unknown pins, unknown categories, and missing categories — fix anything it reports and call it again.",
    inputSchema: {
      type: "object",
      properties: {
        recommendations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string", enum: CATEGORIES },
              pin_id: { type: "string" },
              reason: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["category", "pin_id", "reason", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["recommendations"],
      additionalProperties: false,
    },
    run: async ({ recommendations }) => {
      const usableIds = new Set(metrics.filter((m) => m.usable).map((m) => m.id));
      const problems = [];
      const seen = new Set();

      for (const rec of recommendations ?? []) {
        if (!CATEGORIES.includes(rec.category)) {
          problems.push(`"${rec.category}" is not a valid category.`);
          continue;
        }
        if (seen.has(rec.category)) problems.push(`${rec.category} was given twice.`);
        seen.add(rec.category);

        if (!usableIds.has(rec.pin_id)) {
          problems.push(
            `${rec.category} points at "${rec.pin_id}", which is not a usable pin. Valid pins: ${[...usableIds].join(", ")}.`
          );
        }
        if (!rec.reason?.trim()) problems.push(`${rec.category} has an empty reason.`);
      }

      const missing = CATEGORIES.filter((c) => !seen.has(c));
      if (missing.length) problems.push(`Missing categories: ${missing.join(", ")}.`);

      if (problems.length) {
        return JSON.stringify({ ok: false, problems });
      }

      session.recommendations = recommendations;
      return JSON.stringify({ ok: true });
    },
  });

  return [analyzeTool, scoreTool, proximityTool, finalizeTool];
}

/** Attach pixel coordinates so the frontend can redraw pins without a lookup. */
function decorate(recommendations, metrics, mode, vision) {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  return {
    mode,
    degraded: mode !== "agent",
    room_summary: vision?.overall_confidence >= 0.4 ? vision.room_summary : "",
    zones: vision?.overall_confidence >= 0.4 ? vision.zones : [],
    metrics: metrics.filter((m) => m.usable),
    unreliable: metrics.filter((m) => !m.usable).map((m) => m.id),
    recommendations: recommendations
      .map((rec) => {
        const pin = byId.get(rec.pin_id);
        if (!pin) return null;
        return { ...rec, x: pin.x, y: pin.y };
      })
      .filter(Boolean),
  };
}

export async function recommend({ photo, pins }) {
  const metrics = computeMetrics(pins);
  const usable = metrics.filter((m) => m.usable);

  if (usable.length < 2) {
    return decorate(deterministicRecommendations(metrics), metrics, "numbers", null);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[agent] no API key — deterministic result only");
    return decorate(deterministicRecommendations(metrics), metrics, "numbers", null);
  }

  const client = new Anthropic({ timeout: AGENT_TIMEOUT_MS, maxRetries: 1 });
  const session = { vision: null, recommendations: null };

  // The whole agent is on a wall-clock budget. Judges will not wait, and a
  // slightly duller answer that arrives beats a better one that doesn't.
  const budget = new Promise((resolve) =>
    setTimeout(() => resolve("timeout"), AGENT_TIMEOUT_MS)
  );

  try {
    const run = (async () => {
      await client.beta.messages.toolRunner({
        model: "claude-opus-5",
        max_tokens: 4096,
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        tools: buildTools(client, { photo, metrics, session }),
        messages: [{ role: "user", content: buildPinSummary(metrics) }],
      });
      return "done";
    })();

    const outcome = await Promise.race([run, budget]);

    if (outcome === "timeout") console.warn("[agent] timed out, falling back to numbers");

    if (session.recommendations?.length === CATEGORIES.length) {
      return decorate(session.recommendations, metrics, "agent", session.vision);
    }
  } catch (err) {
    console.error("[agent] failed:", err?.message ?? err);
  }

  // Layer 3: the answer that always exists.
  return decorate(deterministicRecommendations(metrics), metrics, "numbers", session.vision);
}
