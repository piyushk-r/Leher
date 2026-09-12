import {
  computeMetrics,
  rankFor,
  pinZoneProximity,
  deterministicRecommendations,
  PROFILES,
  FLAT_SPREAD_THRESHOLD,
  capabilities,
  describeSpot,
  spotHeadline,
} from "./metrics.js";
import { analyzeRoomPhoto } from "./vision.js";
import { createClient, hasCredentials, AGENT_MODEL, AGENT_REASONING } from "./llm.js";

// Tuned against the free tier, where the binding constraint is tokens per
// minute rather than latency, metered separately for each model.
//
// Two things shape the loop. The vision call runs on a different model (see
// llm.js) so it does not compete with the orchestrator for budget. And the
// orchestrator does not reliably batch parallel tool calls — it tends to take
// one turn per call, each resending the whole growing conversation — so the
// tool surface is deliberately three fat tools rather than five thin ones.
const AGENT_TIMEOUT_MS = 25_000;
const MAX_ITERATIONS = 5;
const CATEGORIES = ["work", "gaming", "overall"];

const SYSTEM_PROMPT = `You are Leher's recommendation agent. Someone photographed a room, stood at
several spots in it, and ran a real network probe at each. Decide which spot
suits which activity.

You cannot see the photo — call analyze_room_photo for that. Do not do
arithmetic yourself — call score_spots.

You have exactly three tools and each is called exactly ONCE:
  1. analyze_room_photo  — the zones, and which spot sits in which
  2. score_spots         — all three rankings at once
  3. finalize_recommendations — your answer
Then reply only: done.

Never call the same tool twice. Calling 1 and 2 together in one message is
ideal; if you call them one at a time that is fine too, but do not add extra
turns beyond these three — the rate limit is tight and a wasted turn costs the
user their answer.

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
- Each spot carries a "works" list: the activities it actually supports,
  computed from real thresholds. That is measured fact. NEVER contradict it —
  if works includes "online gaming", do not call the spot barely usable, and
  if works is only ["messaging"], do not promise streaming.

Also write a spot_note for EVERY measured spot, winners included — the user
tapped each one and wants to know what it is good for, not just which three
won. Each note answers "what could I actually do sitting here?"
  headline: 2-4 words, e.g. "Calls and email", "Streaming only", "Barely usable"
  note: one short sentence. If you know the zone, use it — "Right by the bed,
  fine for winding down with a show." Be straight about weak spots; "you could
  message from here, not much else" is more useful than false encouragement.

Each reason and note: ONE warm plain sentence, 8-16 words, like telling a
friend.
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
        "Look at the room photo: returns the zones in it (desk, seating, bed, kitchen...) with a confidence, AND which zone each measured spot sits in. Call once.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "score_spots",
      description:
        "Rank the measured spots for ALL THREE activity profiles at once (work, gaming, balanced), with the spread verdict for each. Call once.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_recommendations",
      description:
        "Submit the final answer: one pin per category, plus a short note on every spot. Rejects unknown pins or missing categories — fix and call again.",
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
          spot_notes: {
            type: "array",
            description: "One entry for EVERY measured spot, including the winners.",
            items: {
              type: "object",
              properties: {
                pin_id: { type: "string" },
                headline: {
                  type: "string",
                  description:
                    "2-4 words for what this spot is for, e.g. 'Calls and email' or 'Streaming only'.",
                },
                note: {
                  type: "string",
                  description:
                    "One short sentence on what you could do sitting here. Mention the room if you know it.",
                },
              },
              required: ["pin_id", "headline", "note"],
            },
          },
        },
        required: ["recommendations", "spot_notes"],
      },
    },
  },
];

function buildHandlers(client, { photo, metrics, session }) {
  return {
    // Awaits the prefetch started in recommend(), so by the time the model
    // asks for zones the answer is usually already sitting there.
    //
    // Returns proximity alongside the zones rather than as a second tool. The
    // orchestrating model does not reliably batch parallel tool calls, so each
    // extra tool is another full round trip that resends the whole growing
    // conversation — and proximity is derived from these very zones, so
    // splitting them bought nothing but tokens.
    analyze_room_photo: async () => {
      session.vision = await session.visionPromise;
      const { zones, overall_confidence, room_summary } = session.vision;

      return {
        room_summary,
        overall_confidence,
        zones,
        spots_in_zones: zones.length
          ? pinZoneProximity(metrics, zones).map((p) => ({
              pin: p.pin_id,
              zone: p.zone,
              in: p.containment === "inside",
              away_pct: p.distance_pct,
            }))
          : [],
      };
    },

    // All three profiles in one call. The orchestrator does not batch parallel
    // tool calls, so three separate score_spots calls meant three round trips
    // and three resends of the conversation.
    score_spots: async () => {
      const out = {};
      for (const name of Object.keys(PROFILES)) {
        const { ranking, spread, spread_verdict } = rankFor(metrics, name);
        out[name] = {
          ranking: ranking.map((r) => ({
            pin: r.pin_id,
            score: Math.round(r.composite),
            ms: r.median_rtt_ms,
            jitter: r.jitter_ms,
            mbps: r.mbps,
            // Measured fact, not opinion: what this spot actually supports,
            // from published requirements per activity. The model kept
            // guessing capability from raw ping and getting it wrong.
            works: capabilities(metrics.find((m) => m.id === r.pin_id)).good,
          })),
          spread: Math.round(spread),
          spread_verdict,
        };
      }
      const excluded = metrics.filter((m) => !m.usable).map((m) => m.id);
      return { profiles: out, flat_below: FLAT_SPREAD_THRESHOLD, ...(excluded.length ? { excluded_pins: excluded } : {}) };
    },

    finalize_recommendations: async ({ recommendations, spot_notes }) => {
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

      // Notes are accepted leniently. A missing or malformed one falls back to
      // the deterministic description, which is always available — worth a
      // slightly less colourful line rather than bouncing the model into
      // another turn it cannot afford against the rate limit.
      session.spotNotes = (spot_notes ?? []).filter(
        (n) => usableIds.has(n?.pin_id) && n.note?.trim()
      );
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
      reasoning_effort: AGENT_REASONING,
      tools: TOOL_SCHEMAS,
      messages,
    });

    const message = response.choices?.[0]?.message;
    if (!message) break;
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (message.content?.trim()) session.lastText = message.content;

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

  // The model sometimes writes the finished answer as plain JSON text instead
  // of calling finalize_recommendations — the structure is right, the wrapper
  // is missing. Salvaging it costs nothing and saves a whole extra round trip
  // against a tight rate limit. It goes through exactly the same validation,
  // so a malformed salvage is rejected like any other bad tool call.
  if (!session.recommendations && session.lastText) {
    const parsed = extractJson(session.lastText);
    if (parsed?.recommendations) {
      await handlers.finalize_recommendations(parsed);
      if (session.recommendations) console.warn("[agent] salvaged answer from text");
    }
  }
}

/** Pull a JSON object out of a text reply, tolerating ```json fences. */
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- assemble */

function decorate(recommendations, metrics, mode, vision, spotNotes = []) {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const trusted = (vision?.overall_confidence ?? 0) >= 0.4;
  const noteById = new Map(spotNotes.map((n) => [n.pin_id, n]));
  const usable = metrics.filter((m) => m.usable);

  // Every measured spot gets a verdict, whether or not it won a category and
  // whether or not the agent ran. describeSpot() is derived from the numbers
  // alone, so the feature never disappears in the fallback path.
  const spots = usable.map((m) => {
    const written = noteById.get(m.id);
    const { good } = capabilities(m);
    return {
      pin_id: m.id,
      x: m.x,
      y: m.y,
      headline: written?.headline ?? spotHeadline(m),
      note: written?.note ?? describeSpot(m),
      works: good,
      median_rtt_ms: m.median_rtt_ms,
      jitter_ms: m.jitter_ms,
      mbps: m.mbps,
    };
  });

  return {
    mode,
    degraded: mode !== "agent",
    room_summary: trusted ? vision.room_summary : "",
    zones: trusted ? vision.zones : [],
    metrics: usable,
    spots,
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
  const session = { vision: null, recommendations: null, spotNotes: [] };

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
      return decorate(session.recommendations, metrics, "agent", session.vision, session.spotNotes);
    }
  } catch (err) {
    console.error("[agent] failed:", err?.message ?? err);
  }

  // Layer 3: the answer that always exists.
  return decorate(deterministicRecommendations(metrics), metrics, "numbers", session.vision);
}
