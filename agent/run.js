import {
  computeMetrics,
  rankFor,
  pinZoneProximity,
  deterministicRecommendations,
  PROFILES,
  FLAT_SPREAD_THRESHOLD,
} from "./metrics.js";
import { analyzeRoomPhoto } from "./vision.js";
import { createClient, hasCredentials, AGENT_MODEL } from "./llm.js";

// Tuned against the free-tier model: each agent turn costs 1.5-4s and the loop
// needs three of them, so 18s left no headroom. The vision call no longer sits
// on the critical path (see the prefetch in recommend()), which buys most of
// the difference back.
const AGENT_TIMEOUT_MS = 25_000;
const MAX_ITERATIONS = 6;
const CATEGORIES = ["work", "gaming", "overall"];

const SYSTEM_PROMPT = `You are Leher's recommendation agent. Someone photographed a room, stood at
several spots in it, and ran a real network probe at each. Decide which spot
suits which activity.

You cannot see the photo — call analyze_room_photo for that. Do not do
arithmetic yourself — call score_spots.

Turn 1: call analyze_room_photo AND score_spots for all three profiles
("work", "gaming", "balanced") together. Turn 2: pin_zone_proximity.
Turn 3: finalize_recommendations. Then reply only: done.

Categories, one pin each:
  work    — desk work and video calls; steadiness beats raw speed
  gaming  — latency and jitter dominate, throughput barely matters
  overall — best all-round connection
One pin may win several. That is normal, not a failure.

Judgement:
- The numbers are ground truth. Never overrule a clearly better-measuring spot
  because a zone label sounds nicer.
- Zones say what a spot is FOR. When two pins measure close, the one in the
  fitting zone wins — that is the call you are here to make.
- overall_confidence below 0.4, or no zones: ignore the room entirely, use the
  measurements, and talk only about the connection.
- spread_verdict "flat": the spots are inside measurement noise. Do not invent
  a winner — say the room is uniformly fine and to choose for comfort.

Each reason: ONE warm plain sentence, 8-16 words, like telling a friend.
- Do NOT name the pin — the card already shows which one it is.
- At most ONE number, only if it earns its place. This is not a readout.
- Never mention signal strength, bars or dBm. We measured latency and
  throughput, not signal.

confidence: "high" when clear on numbers and context, "medium" when close,
"low" when measurements-only or the spread was flat.`;

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

/* ------------------------------------------------------------------ tools */

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "analyze_room_photo",
      description:
        "Look at the room photo and return the functional zones in it (desk, seating, bed, kitchen...) with approximate positions as percentages of the image, plus a confidence. Call this once.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "score_spots",
      description:
        "Score and rank every measured spot for one activity profile. Returns per-pin latency/jitter/throughput sub-scores, the weighted composite, the ranking, and whether the spread between spots is meaningful or flat (inside measurement noise).",
      parameters: {
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
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pin_zone_proximity",
      description:
        "For each measured spot, report which zone from analyze_room_photo it sits in, or the nearest one and how far away. Call analyze_room_photo first.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_recommendations",
      description:
        "Submit the final answer: exactly one pin per category, each with a one-line human reason. Rejects unknown pins, unknown categories and missing categories — fix anything it reports and call it again.",
      parameters: {
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
            },
          },
        },
        required: ["recommendations"],
      },
    },
  },
];

function buildHandlers(client, { photo, metrics, session }) {
  return {
    // Awaits the prefetch started in recommend(), so by the time the model
    // asks for zones the answer is usually already sitting there.
    analyze_room_photo: async () => {
      session.vision = await session.visionPromise;
      return session.vision;
    },

    // Kept deliberately lean. Every tool result is resent with each subsequent
    // turn, so verbose JSON here is paid for three times over against a 7000
    // input-tokens-per-minute ceiling.
    score_spots: async ({ profile }) => {
      const name = PROFILES[profile] ? profile : "balanced";
      const { ranking, spread, spread_verdict, excluded_pins } = rankFor(metrics, name);
      return {
        profile: name,
        ranking: ranking.map((r) => ({
          pin: r.pin_id,
          score: Math.round(r.composite),
          ms: r.median_rtt_ms,
          jitter: r.jitter_ms,
          mbps: r.mbps,
        })),
        spread: Math.round(spread),
        spread_verdict,
        flat_below: FLAT_SPREAD_THRESHOLD,
        ...(excluded_pins.length ? { excluded_pins } : {}),
      };
    },

    pin_zone_proximity: async () => {
      session.vision ??= await session.visionPromise;
      if (!session.vision?.zones?.length) {
        return { error: "No zones were readable in this photo — recommend on the measurements alone." };
      }
      // Slimmed: the model needs pin -> zone and how close, not prose.
      return {
        proximity: pinZoneProximity(metrics, session.vision.zones).map((p) => ({
          pin: p.pin_id,
          zone: p.zone,
          in: p.containment === "inside",
          away_pct: p.distance_pct,
        })),
        zone_confidence: session.vision.overall_confidence,
      };
    },

    finalize_recommendations: async ({ recommendations }) => {
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

      if (problems.length) return { ok: false, problems };

      session.recommendations = recommendations;
      return { ok: true };
    },
  };
}

/* ------------------------------------------------------------------- loop */

async function runAgent(client, { photo, metrics, session }) {
  const handlers = buildHandlers(client, { photo, metrics, session });
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildPinSummary(metrics) },
  ];

  for (let turn = 0; turn < MAX_ITERATIONS; turn += 1) {
    const started = Date.now();
    const response = await client.chat.completions.create({
      model: AGENT_MODEL,
      max_tokens: 2000,
      reasoning_effort: "none",
      tools: TOOL_SCHEMAS,
      messages,
    });

    const message = response.choices?.[0]?.message;
    if (!message) break;
    messages.push(message);

    const calls = message.tool_calls ?? [];

    if (process.env.LEHER_TRACE) {
      console.log(
        `  [turn ${turn + 1}] ${Date.now() - started}ms  ` +
          `in ${response.usage?.prompt_tokens ?? "?"} / out ${response.usage?.completion_tokens ?? "?"} tok  ` +
          `calls: ${calls.map((c) => c.function.name).join(", ") || "(none)"}` +
          (message.content ? `  text: ${JSON.stringify(message.content.slice(0, 90))}` : "")
      );
    }

    if (calls.length === 0) break;

    // All the tool calls in one assistant turn come back in one batch — the
    // model is allowed to fire analyze_room_photo and score_spots together.
    for (const call of calls) {
      const handler = handlers[call.function.name];
      let result;

      if (!handler) {
        result = { error: `Unknown tool "${call.function.name}".` };
      } else {
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = await handler(args);
        } catch (err) {
          // Malformed arguments are the model's problem to fix, not a crash.
          result = { error: `Could not run that call: ${err.message}` };
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    if (session.recommendations) break;
  }
}

/* ---------------------------------------------------------------- assemble */

function decorate(recommendations, metrics, mode, vision) {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const trusted = (vision?.overall_confidence ?? 0) >= 0.4;

  return {
    mode,
    degraded: mode !== "agent",
    room_summary: trusted ? vision.room_summary : "",
    zones: trusted ? vision.zones : [],
    metrics: metrics.filter((m) => m.usable),
    unreliable: metrics.filter((m) => !m.usable).map((m) => m.id),
    recommendations: recommendations
      .map((rec) => {
        const pin = byId.get(rec.pin_id);
        return pin ? { ...rec, x: pin.x, y: pin.y } : null;
      })
      .filter(Boolean),
  };
}

export async function recommend({ photo, pins }) {
  const metrics = computeMetrics(pins);
  const usable = metrics.filter((m) => m.usable);

  if (usable.length < 2 || !hasCredentials()) {
    if (!hasCredentials()) console.warn("[agent] no API key — deterministic result only");
    return decorate(deterministicRecommendations(metrics), metrics, "numbers", null);
  }

  const client = createClient({ timeout: AGENT_TIMEOUT_MS });
  const session = { vision: null, recommendations: null };

  // Start looking at the photo now, before the model has asked. The agent's
  // first turn and the vision call then run concurrently instead of in series,
  // which is most of the difference between finishing inside the budget and
  // timing out. A rejection here must not become an unhandled rejection.
  session.visionPromise = analyzeRoomPhoto(client, photo).catch((err) => ({
    zones: [],
    overall_confidence: 0,
    room_summary: "",
    error: err?.message ?? "vision failed",
  }));

  // The whole agent is on a wall-clock budget. Judges will not wait, and a
  // slightly duller answer that arrives beats a better one that doesn't.
  const budget = new Promise((resolve) => setTimeout(() => resolve("timeout"), AGENT_TIMEOUT_MS));

  try {
    const outcome = await Promise.race([
      runAgent(client, { photo, metrics, session }).then(() => "done"),
      budget,
    ]);
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
