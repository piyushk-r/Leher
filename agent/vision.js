/**
 * analyze_room_photo — the agent's only eyes.
 *
 * The orchestrating agent is deliberately given NO image. It sees pin ids,
 * coordinates and numbers, and nothing else. If it wants to know what is
 * actually in the room it has to call this tool, which runs a separate
 * vision request and returns structured zones. That makes the tool load-
 * bearing rather than decorative: the model cannot shortcut around it.
 *
 * Structured output is obtained with forced tool use (`tool_choice`), which is
 * supported on claude-opus-5 and gives a schema-validated object back.
 */

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
  name: "report_zones",
  description: "Report the functional zones visible in the room photo.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      room_summary: {
        type: "string",
        description: "One short sentence describing the room as a whole.",
      },
      overall_confidence: {
        type: "number",
        description:
          "0-1. How confident you are overall that you read this room correctly. Be honest: a dark, blurry, cluttered or ambiguous photo should score below 0.4.",
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
                "A few words a person would recognise, e.g. 'desk under the window' or 'sofa facing the TV'.",
            },
            bbox_pct: {
              type: "array",
              description:
                "[x, y, width, height] as percentages of the image, 0-100, origin at top-left.",
              items: { type: "number" },
              minItems: 4,
              maxItems: 4,
            },
            confidence: { type: "number", description: "0-1 for this specific zone." },
          },
          required: ["label", "description", "bbox_pct", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["room_summary", "overall_confidence", "zones"],
    additionalProperties: false,
  },
};

const SYSTEM = `You label functional zones in a photo of someone's room.

Return only zones you can actually see. Four or fewer is normal; a photo of one
corner may only have one. Never invent a zone to fill the list.

Coordinates are percentages of the image: [x, y, width, height] with the origin
at the top-left, so a desk in the upper-left quarter is roughly [5, 10, 40, 35].
Rough boxes are fine — they are used to decide which measured spot sits in which
part of the room, nothing more.

Be genuinely honest about confidence. If the photo is dim, blurry, heavily
cluttered, or mostly a blank wall, say so with a low overall_confidence. A
truthful "I can't read this room" is far more useful to the system downstream
than a confident guess, because it will cleanly fall back to measurements only.`;

function stripDataUrl(photo) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(photo ?? "");
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

export async function analyzeRoomPhoto(client, photo, { timeoutMs = 12_000 } = {}) {
  const parsed = stripDataUrl(photo);
  if (!parsed) {
    return { zones: [], overall_confidence: 0, room_summary: "", error: "no usable photo" };
  }

  try {
    const response = await client.messages.create(
      {
        model: "claude-opus-5",
        max_tokens: 2048,
        output_config: { effort: "low" },
        system: SYSTEM,
        tools: [REPORT_ZONES_TOOL],
        tool_choice: { type: "tool", name: "report_zones" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
              },
              { type: "text", text: "Label the functional zones in this room." },
            ],
          },
        ],
      },
      { timeout: timeoutMs }
    );

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block) {
      return { zones: [], overall_confidence: 0, room_summary: "", error: "no zones returned" };
    }

    const result = block.input;
    const zones = (result.zones ?? [])
      .filter((z) => Array.isArray(z.bbox_pct) && z.bbox_pct.length === 4)
      .slice(0, 5);

    return {
      zones,
      overall_confidence: result.overall_confidence ?? 0,
      room_summary: result.room_summary ?? "",
    };
  } catch (err) {
    console.error("[vision] failed:", err?.message ?? err);
    return {
      zones: [],
      overall_confidence: 0,
      room_summary: "",
      error: "vision call failed",
    };
  }
}
