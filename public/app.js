/* Leher — client.
 *
 * Three responsibilities: get a photo small enough to send, time real network
 * probes honestly, and draw the answer back onto the same photo.
 */

const $ = (id) => document.getElementById(id);

const MIN_SPOTS = 3;
const PING_COUNT = 9;          // first one is discarded
const PAYLOAD_BYTES = 300_000;      // starting size; grows on a fast link
const MAX_PAYLOAD_BYTES = 2_000_000; // matches the server's cap
const PAYLOAD_RUNS = 3;             // attempts, not necessarily all used
const MIN_TRANSFER_SECONDS = 0.25;  // below this the number is RTT, not bandwidth
const MIN_PIN_ANIMATION_MS = 1100;

const CATEGORY_META = {
  work: { emoji: "💼", title: "Great for work" },
  gaming: { emoji: "🎮", title: "Best for gaming" },
  overall: { emoji: "📶", title: "Best connection" },
};

const state = {
  photo: null,
  pins: [],
  nextId: 1,
  queue: Promise.resolve(),
  busy: false,
};

/* ------------------------------------------------------------- screens */

function show(name) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = true;
  $(`screen-${name}`).hidden = false;
  window.scrollTo(0, 0);
}

/* --------------------------------------------------------------- photo */

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through to the <img> path */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Resize before upload. A phone photo is 3-8 MB; at 1024px/q0.72 it is ~150 KB
 * and about a thousand vision tokens, which keeps the agent call fast and the
 * page responsive.
 */
async function resizePhoto(file, maxEdge = 1024, quality = 0.72) {
  const source = await decode(file);
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  if (!sw || !sh) throw new Error("empty image");

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();

  return canvas.toDataURL("image/jpeg", quality);
}

$("photo-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const error = $("start-error");
  error.hidden = true;
  $("photo-label-text").textContent = "Getting your photo ready…";

  try {
    state.photo = await resizePhoto(file);
    $("measure-photo").src = state.photo;
    $("results-photo").src = state.photo;
    show("measure");
  } catch {
    error.textContent = "That image didn't load. Try another photo.";
    error.hidden = false;
  } finally {
    $("photo-label-text").textContent = "Take a photo of your room";
    event.target.value = "";
  }
});

/* --------------------------------------------------------- probe engine */

async function timedPing() {
  const t0 = performance.now();
  const response = await fetch(`/api/ping?cb=${Math.random()}`, { cache: "no-store" });
  const elapsed = performance.now() - t0;
  if (!response.ok && response.status !== 204) throw new Error(`ping ${response.status}`);
  return elapsed;
}

async function timedDownload(bytes) {
  const t0 = performance.now();
  const response = await fetch(`/api/payload?bytes=${bytes}&cb=${Math.random()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`payload ${response.status}`);
  const buffer = await response.arrayBuffer();
  return { bytes: buffer.byteLength, seconds: (performance.now() - t0) / 1000 };
}

/**
 * One spot's measurement. The warm-up request is deliberately discarded — it
 * absorbs connection setup and any Render cold-start cost, which would
 * otherwise be blamed on wherever the user happened to tap first.
 */
async function probeSpot() {
  await timedPing().catch(() => {});

  const rtts = [];
  for (let i = 0; i < PING_COUNT; i += 1) rtts.push(await timedPing());
  rtts.shift();

  // Adaptive sizing. A transfer that finishes in a few milliseconds is not
  // measuring bandwidth, it is measuring round-trip time — so on a fast link
  // we re-run with a bigger payload until the transfer is long enough to mean
  // something. On a slow spot the first run already takes long enough and we
  // stop there, which keeps the worst corner of the room quick to measure.
  const runs = [];
  let bytes = PAYLOAD_BYTES;
  for (let i = 0; i < PAYLOAD_RUNS; i += 1) {
    const run = await timedDownload(bytes);
    runs.push(run);
    if (run.seconds > MIN_TRANSFER_SECONDS) break;
    bytes = Math.min(bytes * 5, MAX_PAYLOAD_BYTES);
  }

  // Once a run is long enough to be meaningful, the short ones are noise.
  const meaningful = runs.filter((r) => r.seconds > MIN_TRANSFER_SECONDS);
  return { rtts, runs: meaningful.length ? meaningful : runs.slice(-1) };
}

/* ----------------------------------------------------------------- pins */

function renderPin(pin) {
  pin.el.className = `pin pin--${pin.status}`;
  pin.el.style.left = `${pin.x * 100}%`;
  pin.el.style.top = `${pin.y * 100}%`;
  pin.el.innerHTML =
    pin.status === "failed"
      ? '<span class="pin__core">↻</span>'
      : '<span class="pin__core"></span>';
  pin.el.title =
    pin.status === "failed"
      ? "Couldn't measure here — tap it again"
      : pin.status === "measuring"
        ? "Measuring…"
        : pin.label;
}

function updateCounter() {
  const done = state.pins.filter((p) => p.status === "done").length;
  const measuring = state.pins.some((p) => p.status === "measuring");

  $("counter").textContent =
    done === 0
      ? measuring
        ? "Measuring your first spot…"
        : "No spots measured yet"
      : done < MIN_SPOTS
        ? `${done} spot${done === 1 ? "" : "s"} measured`
        : `${done} spots measured — tap a few more, or see results`;

  const ready = done >= MIN_SPOTS && !measuring;
  $("see-results").disabled = !ready;
  $("measure-hint").textContent =
    done < MIN_SPOTS
      ? `Tap at least ${MIN_SPOTS} spots`
      : measuring
        ? "Finishing that spot…"
        : "";
}

function measure(pin) {
  pin.status = "measuring";
  renderPin(pin);
  updateCounter();

  // Probes run one at a time. Two concurrent probes share the same link and
  // would each under-report, which would quietly corrupt the comparison.
  state.queue = state.queue.then(async () => {
    const started = performance.now();
    try {
      pin.samples = await probeSpot();
      pin.status = "done";
    } catch {
      pin.status = "failed";
    }
    const elapsed = performance.now() - started;
    if (elapsed < MIN_PIN_ANIMATION_MS) {
      await new Promise((r) => setTimeout(r, MIN_PIN_ANIMATION_MS - elapsed));
    }
    renderPin(pin);
    updateCounter();
  });
}

$("measure-pins").addEventListener("click", (event) => {
  // Tapping a failed pin retries that spot rather than adding a new one.
  const existing = event.target.closest(".pin");
  if (existing) {
    const pin = state.pins.find((p) => p.el === existing);
    if (pin && pin.status === "failed") measure(pin);
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const y = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);

  const el = document.createElement("div");
  $("measure-pins").append(el);

  const pin = { id: `Pin ${state.nextId}`, label: `Pin ${state.nextId}`, x, y, el, status: "measuring" };
  state.nextId += 1;
  state.pins.push(pin);

  measure(pin);
});

/* -------------------------------------------------------------- results */

const THINKING_COPY = [
  "Looking at your room…",
  "Comparing your spots…",
  "Picking the best seats…",
];

function startThinking() {
  const overlay = $("thinking");
  const text = $("thinking-text");
  let i = 0;
  text.textContent = THINKING_COPY[0];
  overlay.hidden = false;
  const timer = setInterval(() => {
    i = (i + 1) % THINKING_COPY.length;
    text.textContent = THINKING_COPY[i];
  }, 2600);
  return () => {
    clearInterval(timer);
    overlay.hidden = true;
  };
}

function renderResults(payload) {
  const pinsEl = $("results-pins");
  const cardsEl = $("cards");
  pinsEl.innerHTML = "";
  cardsEl.innerHTML = "";

  // One badge per pin, even when a pin wins more than one category —
  // stacking two badges on the same coordinate just looks broken.
  const byPin = new Map();
  for (const rec of payload.recommendations) {
    if (!byPin.has(rec.pin_id)) byPin.set(rec.pin_id, { x: rec.x, y: rec.y, cats: [] });
    byPin.get(rec.pin_id).cats.push(rec.category);
  }

  let n = 0;
  for (const [pinId, info] of byPin) {
    const el = document.createElement("div");
    el.className = "pin pin--result";
    el.style.left = `${info.x * 100}%`;
    el.style.top = `${info.y * 100}%`;
    el.style.animationDelay = `${n * 140}ms`;
    el.innerHTML =
      `<span class="emoji">${info.cats.map((c) => CATEGORY_META[c].emoji).join("")}</span>` +
      `<span>${pinId}</span>`;
    pinsEl.append(el);
    n += 1;
  }

  const metricsById = new Map(payload.metrics.map((m) => [m.id, m]));

  payload.recommendations.forEach((rec, i) => {
    const meta = CATEGORY_META[rec.category];
    const metric = metricsById.get(rec.pin_id);
    const card = document.createElement("div");
    card.className = "card";
    card.style.animationDelay = `${i * 90}ms`;
    card.innerHTML =
      `<div class="card__emoji">${meta.emoji}</div>` +
      `<div><p class="card__title">${meta.title}</p>` +
      `<p class="card__reason"></p>` +
      `<p class="card__meta">${rec.pin_id}${metric ? ` · ${metric.median_rtt_ms} ms · ${metric.mbps} Mbps` : ""}</p></div>`;
    card.querySelector(".card__reason").textContent = rec.reason;
    cardsEl.append(card);
  });

  const note = $("results-note");
  if (payload.degraded) {
    note.textContent =
      "We couldn't read the room this time, so this is based on your measurements alone.";
    note.hidden = false;
  } else if (payload.room_summary) {
    note.textContent = payload.room_summary;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  const table = $("numbers-table");
  table.innerHTML =
    "<tr><th>Spot</th><th>Ping</th><th>Jitter</th><th>Speed</th></tr>" +
    payload.metrics
      .map(
        (m) =>
          `<tr><td>${m.id}</td><td>${m.median_rtt_ms} ms</td><td>${m.jitter_ms} ms</td><td>${m.mbps} Mbps</td></tr>`
      )
      .join("");
  $("numbers").hidden = payload.metrics.length === 0;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Last-ditch local answer if the request itself never lands. */
function offlineFallback(measured) {
  const best = measured
    .map((p) => ({ id: p.id, x: p.x, y: p.y, rtt: median(p.samples.rtts) }))
    .sort((a, b) => a.rtt - b.rtt)[0];

  return {
    mode: "offline",
    degraded: true,
    room_summary: "",
    recommendations: [
      {
        category: "overall",
        pin_id: best.id,
        x: best.x,
        y: best.y,
        reason: `Lowest ping of the spots you measured — about ${Math.round(best.rtt)} ms.`,
        confidence: "low",
      },
    ],
    metrics: measured.map((p) => ({
      id: p.id,
      median_rtt_ms: Math.round(median(p.samples.rtts)),
      jitter_ms: "—",
      mbps: "—",
    })),
  };
}

$("see-results").addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true;

  const measured = state.pins.filter((p) => p.status === "done");
  show("results");
  const stopThinking = startThinking();

  try {
    const response = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photo: state.photo,
        pins: measured.map((p) => ({ id: p.id, x: p.x, y: p.y, samples: p.samples })),
      }),
    });
    if (!response.ok) throw new Error(`recommend ${response.status}`);
    renderResults(await response.json());
  } catch (err) {
    console.error(err);
    renderResults(offlineFallback(measured));
  } finally {
    stopThinking();
    state.busy = false;
  }
});

$("restart").addEventListener("click", () => {
  state.photo = null;
  state.pins = [];
  state.nextId = 1;
  state.queue = Promise.resolve();
  $("measure-pins").innerHTML = "";
  updateCounter();
  show("start");
});

/* Wake the instance while the user is still reading screen 1, so the first
 * spot they tap isn't measuring a cold server. */
fetch("/health", { cache: "no-store" }).catch(() => {});

updateCounter();
