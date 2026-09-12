/**
 * analyze_room_photo — the agent's only eyes.
 *
 * The orchestrating agent is deliberately given NO image. It sees pin ids,
 * coordinates and numbers, and nothing else. If it wants to know what is
 * actually in the room it has to call this tool, which runs a separate vision
 * request and returns structured zones. That makes the tool load-bearing
 * rather than decorative: the model cannot shortcut around it.
 *
 * Structured output comes from forced tool use, which is more reliable on an
 * open model than asking for raw JSON and hoping.
 */

import { VISION_MODEL } from "./llm.js";

const ZONE_LABELS = [
  "workspace",
  "seating",
  "bed",
  "kitchen",
  "dining",
  "doorway",
  "window",
  "floor",
  "other",
];

const REPORT_ZONES_TOOL = {
  type: "function",
  function: {
    name: "report_zones",
    description: "Report the functional zones visible in the room photo.",
    parameters: {
      type: "object",
      properties: {
        room_summary: {
          type: "string",
          description: "One short sentence describing the room as a whole.",
        },
        overall_confidence: {
          type: "number",
          description:
            "0-1. How confident you are that you read this room correctly. A dark, blurry, cluttered or ambiguous photo should score below 0.4.",
        },
        zones: {
          type: "array",
          description: "Up to 5 functional zones. Omit anything you are guessing at.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", enum: ZONE_LABELS },
              description: {
                type: "string",
                description:
                  "A few words a person would recognise, e.g. 'desk under the window'.",
              },
              bbox_pct: {
                type: "array",
                description:
                  "[x, y, width, height] as percentages of the image, 0-100, origin top-left.",
                items: { type: "number" },
              },
              confidence: { type: "number", description: "0-1 for this specific zone." },
            },
            required: ["label", "description", "bbox_pct", "confidence"],
          },
        },
      },
      required: ["room_summary", "overall_confidence", "zones"],
    },
  },
};

const SYSTEM = `You label functional zones in a photo of someone's room.

Return only zones you can actually see. Four or fewer is normal; a photo of one
corner may have just one. Never invent a zone to fill the list.

Coordinates are percentages of the image: [x, y, width, height], origin at the
top-left, so a desk in the upper-left quarter is roughly [5, 10, 40, 35]. Rough
boxes are fine — they only decide which measured spot sits in which part of the
room.

Be honest about confidence. If the photo is dim, blurry, heavily cluttered or
mostly blank wall, say so with a low overall_confidence. A truthful "I can't
read this room" is far more useful than a confident guess, because the system
downstream will cleanly fall back to measurements only.`;

function stripDataUrl(photo) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(photo ?? "");
  return match ? { mediaType: match[1], data: match[2] } : null;
}

const MIN_ZONE_SIDE_PCT = 4;

/**
 * Turn a model-supplied box into a trustworthy [x, y, w, h], or reject it.
 *
 * Two things go wrong in practice. The model sometimes drifts into corner
 * coordinates ([x1, y1, x2, y2]) despite the prompt, which is detectable: read
 * that way the box lands inside the image, read as width/height it overflows.
 * And it sometimes emits outright nonsense like [100, 100, 1, 1].
 *
 * Rejecting is much safer than salvaging here. An earlier version clamped
 * w to (100 - x), which silently converted a garbage box into a 1%-wide sliver
 * that still passed every downstream check and then poisoned the pin-to-zone
 * geometry. A dropped zone just means less context; a wrong zone means a
 * confidently wrong recommendation.
 */
function sanitiseBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;

  const nums = box.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return null;

  let [a, b, c, d] = nums;

  // Corner-coordinate drift: [x1,y1,x2,y2] with x2>x1 and y2>y1, where reading
  // c/d as width/height would run off the edge.
  const overflows = a + c > 100.5 || b + d > 100.5;
  if (overflows && c > a && d > b) {
    [a, b, c, d] = [a, b, c - a, d - b];
  }

  const x = Math.max(0, Math.min(100, a));
  const y = Math.max(0, Math.min(100, b));
  const w = Math.min(c, 100 - x);
  const h = Math.min(d, 100 - y);

  // A zone thinner than a few percent of the image is not a real region.
  if (w < MIN_ZONE_SIDE_PCT || h < MIN_ZONE_SIDE_PCT) return null;

  return [x, y, w, h];
}

export async function analyzeRoomPhoto(client, photo, { timeoutMs = 12_000 } = {}) {
  const parsed = stripDataUrl(photo);
  if (!parsed) {
    return { zones: [], overall_confidence: 0, room_summary: "", error: "no usable photo" };
  }

  try {
    const response = await client.chat.completions.create(
      {
        model: VISION_MODEL,
        max_tokens: 1500,
        reasoning_effort: "none",
        tools: [REPORT_ZONES_TOOL],
        tool_choice: { type: "function", function: { name: "report_zones" } },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Label the functional zones in this room." },
              {
                type: "image_url",
                image_url: { url: `data:${parsed.mediaType};base64,${parsed.data}` },
              },
            ],
          },
        ],
      },
      { timeout: timeoutMs }
    );

    if (process.env.LEHER_TRACE) {
      console.log(`  [vision] in ${response.usage?.prompt_tokens ?? "?"} / out ${response.usage?.completion_tokens ?? "?"} tok`);
    }

    const call = response.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) {
      return { zones: [], overall_confidence: 0, room_summary: "", error: "no zones returned" };
    }

    const result = JSON.parse(call.function.arguments);

    const zones = (result.zones ?? [])
      .map((z) => ({ ...z, bbox_pct: sanitiseBox(z.bbox_pct) }))
      .filter((z) => z.bbox_pct && z.label)
      .slice(0, 5);

    return {
      zones,
      overall_confidence: Number(result.overall_confidence) || 0,
      room_summary: result.room_summary ?? "",
    };
  } catch (err) {
    console.error("[vision] failed:", err?.message ?? err);
    return { zones: [], overall_confidence: 0, room_summary: "", error: "vision call failed" };
  }
}
