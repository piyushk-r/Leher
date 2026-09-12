import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { recommend } from "./agent/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.disable("etag");

// The photo arrives as a base64 data URL; the 100kb default would reject it.
app.use(express.json({ limit: "8mb" }));

const NO_STORE = "no-store, no-cache, must-revalidate, max-age=0";

/* ---------------------------------------------------------------- health */

app.get("/health", (_req, res) => {
  res.set("Cache-Control", NO_STORE);
  res.json({ ok: true, agent: Boolean(process.env.GROQ_API_KEY), ts: Date.now() });
});

/* ----------------------------------------------------------- probe targets */

// Latency target. 204, empty body, nothing cacheable, no work on the server —
// anything the server does here lands in the user's measurement.
app.get("/api/ping", (_req, res) => {
  res.set("Cache-Control", NO_STORE);
  res.status(204).end();
});

// Throughput target. The buffer is generated once at boot rather than per
// request: random bytes are ~1ms/300kb of CPU, and on a shared Render instance
// that CPU time would show up as "slow Wi-Fi" in the client's timing.
const MAX_PAYLOAD_BYTES = 2_000_000;
const PAYLOAD_POOL = crypto.randomBytes(MAX_PAYLOAD_BYTES);

app.get("/api/payload", (req, res) => {
  const requested = Number.parseInt(req.query.bytes, 10);
  const bytes = Math.min(Number.isFinite(requested) ? requested : 300_000, MAX_PAYLOAD_BYTES);
  res.set({
    "Cache-Control": NO_STORE,
    "Content-Type": "application/octet-stream",
  });
  res.send(PAYLOAD_POOL.subarray(0, Math.max(bytes, 1)));
});

// Upload throughput target — reads and discards the body.
app.post("/api/upload-probe", express.raw({ type: "*/*", limit: "4mb" }), (req, res) => {
  res.set("Cache-Control", NO_STORE);
  res.json({ ok: true, bytes: req.body?.length ?? 0 });
});

/* ------------------------------------------------------------- the agent */

app.post("/api/recommend", async (req, res) => {
  const { photo, pins } = req.body ?? {};

  if (!Array.isArray(pins) || pins.length < 2) {
    return res.status(400).json({ error: "Need at least 2 measured spots." });
  }

  try {
    const result = await recommend({ photo, pins });
    res.set("Cache-Control", NO_STORE);
    res.json(result);
  } catch (err) {
    // recommend() already owns its own fallbacks, so reaching here means
    // something unexpected broke. Still never hand the client an empty screen.
    console.error("[recommend] unhandled:", err);
    res.status(500).json({ error: "Something went wrong reading your spots." });
  }
});

/* --------------------------------------------------------------- statics */

app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", NO_STORE),
  })
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Leher listening on :${port}`);
  if (!process.env.GROQ_API_KEY) {
    console.warn("GROQ_API_KEY is not set — running in numbers-only mode.");
  }
});
