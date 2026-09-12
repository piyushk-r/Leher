/**
 * The deterministic half of Leher.
 *
 * Everything in this file is pure arithmetic over the raw probe samples the
 * browser collected. The LLM never computes any of it — it only reads the
 * output. Keeping the split this clean is what makes the agent's judgement
 * calls legible: if a recommendation is surprising, the numbers below are the
 * receipts.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, places = 1) => Number(v.toFixed(places));

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation — a jitter estimate that one outlier can't drag. */
export function mad(xs) {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/* ------------------------------------------------------------- sub-scores */

/** <=30ms is excellent, >=250ms is unusable. Linear between. */
export const latencyScore = (rttMs) => (100 * (250 - clamp(rttMs, 30, 250))) / 220;

/** <=5ms of jitter is imperceptible, >=60ms breaks calls and games. */
export const jitterScore = (jitterMs) => (100 * (60 - clamp(jitterMs, 5, 60))) / 55;

/** Log-scaled: the jump from 1 to 5 Mbps matters far more than 25 to 30. */
export const throughputScore = (mbps) =>
  (100 * Math.log10(clamp(mbps, 1, 30))) / Math.log10(30);

/* -------------------------------------------------------------- profiles */

export const PROFILES = {
  work: { lat: 0.35, jit: 0.3, thr: 0.35 },
  gaming: { lat: 0.45, jit: 0.4, thr: 0.15 },
  balanced: { lat: 0.3, jit: 0.25, thr: 0.45 },
};

/**
 * Below this many points of spread between the best and worst spot, the
 * differences are inside measurement noise and picking a "winner" would be
 * inventing precision we don't have. The agent is told to say so instead.
 */
export const FLAT_SPREAD_THRESHOLD = 8;

/* --------------------------------------------------------------- metrics */

export function computeMetrics(pins) {
  return pins.map((pin) => {
    const rtts = (pin.samples?.rtts ?? []).filter((n) => Number.isFinite(n) && n >= 0);
    const runs = (pin.samples?.runs ?? []).filter(
      (r) => Number.isFinite(r?.bytes) && Number.isFinite(r?.seconds) && r.seconds > 0
    );

    if (rtts.length < 4 || runs.length === 0) {
      return { id: pin.id, x: pin.x, y: pin.y, usable: false, reason: "not enough samples" };
    }

    const medianRtt = median(rtts);
    const jitter = mad(rtts);
    // Best-of, not median: TCP slow-start makes a single short transfer
    // under-report the link's actual capacity, so the fastest run is the
    // honest estimate of what the spot can do.
    const mbps = Math.max(...runs.map((r) => (r.bytes * 8) / 1e6 / r.seconds));

    const reliability = 1 - clamp(medianRtt > 0 ? jitter / medianRtt : 1, 0, 1);

    // Deliberately a low bar. A genuinely bad corner of the room IS jittery —
    // that is the finding, not a fault in the measurement — and it already
    // gets punished properly through jitter_score. Excluding it here would
    // quietly delete the most useful spot the user measured. Only throw away
    // samples that are pathological: jitter approaching the median itself,
    // which means the probe never settled at all.
    const usable = reliability >= 0.2;

    return {
      id: pin.id,
      x: pin.x,
      y: pin.y,
      usable,
      median_rtt_ms: round(medianRtt),
      jitter_ms: round(jitter),
      mbps: round(mbps),
      latency_score: round(latencyScore(medianRtt)),
      jitter_score: round(jitterScore(jitter)),
      throughput_score: round(throughputScore(mbps)),
      reliability: round(reliability, 2),
      samples: rtts.length,
    };
  });
}

/** Rank the usable pins for one activity profile. */
export function rankFor(metrics, profileName) {
  const w = PROFILES[profileName] ?? PROFILES.balanced;
  const usable = metrics.filter((m) => m.usable);

  const scored = usable
    .map((m) => ({
      pin_id: m.id,
      composite: round(
        w.lat * m.latency_score + w.jit * m.jitter_score + w.thr * m.throughput_score
      ),
      median_rtt_ms: m.median_rtt_ms,
      jitter_ms: m.jitter_ms,
      mbps: m.mbps,
      reliability: m.reliability,
    }))
    .sort((a, b) => b.composite - a.composite);

  const spread = scored.length
    ? round(scored[0].composite - scored[scored.length - 1].composite)
    : 0;

  return {
    profile: profileName,
    weights: w,
    ranking: scored,
    spread,
    spread_verdict: spread < FLAT_SPREAD_THRESHOLD ? "flat" : "meaningful",
    excluded_pins: metrics.filter((m) => !m.usable).map((m) => m.id),
  };
}

/* -------------------------------------------------------------- geometry */

const DIAGONAL_PCT = Math.hypot(100, 100);

/**
 * Zones arrive as bbox_pct [x, y, w, h] in 0-100 space; pins are stored as
 * 0-1 fractions of the displayed image. Both describe the same picture, so
 * proximity is plain rectangle maths — no real-world distance is implied.
 */
export function pinZoneProximity(metrics, zones) {
  if (!Array.isArray(zones) || zones.length === 0) {
    return metrics.map((m) => ({ pin_id: m.id, zone: null, containment: "none", distance_pct: null }));
  }

  return metrics.map((m) => {
    const px = m.x * 100;
    const py = m.y * 100;

    let best = null;
    for (const zone of zones) {
      const [zx, zy, zw, zh] = zone.bbox_pct;
      const inside = px >= zx && px <= zx + zw && py >= zy && py <= zy + zh;

      const dx = Math.max(zx - px, 0, px - (zx + zw));
      const dy = Math.max(zy - py, 0, py - (zy + zh));
      const distance = inside ? 0 : (Math.hypot(dx, dy) / DIAGONAL_PCT) * 100;

      if (!best || distance < best.distance_pct) {
        best = {
          pin_id: m.id,
          zone: zone.label,
          zone_description: zone.description,
          zone_confidence: zone.confidence,
          containment: inside ? "inside" : "nearest",
          distance_pct: round(distance),
        };
      }
    }
    return best;
  });
}

/* ---------------------------------------------------- what works at a spot */

/**
 * What you can actually do at a spot, from published requirements for each
 * activity rather than invented thresholds.
 *
 * This is deliberately deterministic. Per-spot advice is the part of the
 * product people will read most closely, so it has to survive the agent being
 * rate-limited or unavailable — the LLM adds room-aware colour on top, it is
 * not the source of truth.
 */
const ACTIVITIES = [
  { key: "messaging",   label: "messaging",          mbps: 0.5, rtt: 600, jitter: 200 },
  { key: "browsing",    label: "browsing",           mbps: 1.5, rtt: 400, jitter: 150 },
  { key: "calls",       label: "video calls",        mbps: 3,   rtt: 200, jitter: 30 },
  { key: "hd",          label: "HD streaming",       mbps: 6,   rtt: 400, jitter: 150 },
  { key: "gaming",      label: "online gaming",      mbps: 3,   rtt: 80,  jitter: 20 },
  { key: "uhd",         label: "4K streaming",       mbps: 25,  rtt: 400, jitter: 150 },
  { key: "downloads",   label: "big downloads",      mbps: 20,  rtt: 400, jitter: 200 },
];

export function capabilities(metric) {
  const good = [];
  const poor = [];
  for (const a of ACTIVITIES) {
    const ok = metric.mbps >= a.mbps && metric.median_rtt_ms <= a.rtt && metric.jitter_ms <= a.jitter;
    (ok ? good : poor).push(a.label);
  }
  return { good, poor };
}

/**
 * A 2-4 word label for what a spot is for, named after the most demanding
 * thing that actually works there. Used verbatim when the agent is
 * unavailable, so it has to stand on its own.
 */
export function spotHeadline(metric) {
  const has = new Set(capabilities(metric).good);

  if (has.has("online gaming") && has.has("4K streaming")) return "Anything you like";
  if (has.has("4K streaming")) return "Streaming and downloads";
  if (has.has("online gaming")) return "Gaming and calls";
  if (has.has("video calls") && has.has("HD streaming")) return "Calls and streaming";
  if (has.has("video calls")) return "Calls and work";
  if (has.has("HD streaming")) return "Streaming only";
  if (has.has("browsing")) return "Light browsing";
  if (has.has("messaging")) return "Messaging only";
  return "Barely usable";
}

/** A plain-language line for one spot, with no LLM involved. */
export function describeSpot(metric) {
  const { good } = capabilities(metric);

  if (good.length === 0) return "Too weak to rely on — messages might get through.";
  if (good.length >= 6) return "Handles anything — 4K, calls and gaming all fine here.";

  // Name the most demanding things that work, not everything that works.
  const headline = good.slice(-3).reverse();
  const list =
    headline.length === 1
      ? headline[0]
      : `${headline.slice(0, -1).join(", ")} and ${headline[headline.length - 1]}`;
  return `Good for ${list}.`;
}

/**
 * The answer we can always give, with no LLM involved at all. This is layer 3
 * of the degradation plan and the safety net the whole demo rests on.
 */
export function deterministicRecommendations(metrics) {
  const categories = [
    { category: "work", profile: "work", label: "work" },
    { category: "gaming", profile: "gaming", label: "gaming" },
    { category: "overall", profile: "balanced", label: "overall connection" },
  ];

  const out = [];
  for (const c of categories) {
    const { ranking, spread_verdict } = rankFor(metrics, c.profile);
    if (!ranking.length) continue;
    const top = ranking[0];

    const reason =
      spread_verdict === "flat"
        ? `Your spots all measured about the same — this one is a hair ahead at ${top.median_rtt_ms} ms and ${top.mbps} Mbps.`
        : c.category === "gaming"
          ? `Lowest, steadiest ping here — ${top.median_rtt_ms} ms with ${top.jitter_ms} ms of jitter.`
          : c.category === "work"
            ? `Steady connection here — ${top.median_rtt_ms} ms ping and ${top.mbps} Mbps.`
            : `Fastest spot you measured — ${top.mbps} Mbps at ${top.median_rtt_ms} ms.`;

    out.push({ category: c.category, pin_id: top.pin_id, reason, confidence: "measured" });
  }
  return out;
}
