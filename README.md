# Leher

**Photograph your room, tap a few spots, and an AI agent tells you where to sit.**

Leher measures real network performance — latency, jitter and throughput — at
each spot you tap on a photo of your own room, then reasons about the room *and*
the measurements together to hand back labelled recommendations pinned on that
same photo: 💼 work, 🎮 gaming, 📶 best connection.

> It measures **actively-probed latency and throughput**, not Wi-Fi signal
> strength. No browser on any OS exposes RSSI, and Leher never claims otherwise.

Full product and build spec: [SPEC.md](SPEC.md).

---

## Run it locally

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional; without it you get the
                                      # deterministic numbers-only mode
npm start                             # http://localhost:3000
```

Open it on your **phone**, not your laptop — the whole point is walking around
the room. On the same Wi-Fi, `http://<your-machine-ip>:3000` works.

## Deploy to Render

1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo. `render.yaml` supplies
   the build command, start command and health check path.
3. Add the environment variable **`ANTHROPIC_API_KEY`** in the Render
   dashboard. Never commit it.
4. Use a **paid instance**. The free tier spins down after inactivity, and the
   30–50 s cold start both stalls the demo and makes the first spot the user
   taps look catastrophically slow.
5. Pick the region closest to where you'll demo.

## How it works

### The deterministic half — [`agent/metrics.js`](agent/metrics.js)

Per tapped spot the browser runs a discarded warm-up request, 9 timed pings
(first dropped), and 2 × 300 KB downloads. The server turns those raw samples
into median RTT, MAD-based jitter, best-of Mbps, three 0–100 sub-scores, a
weighted composite per activity profile, and a reliability figure. The LLM
computes none of this.

There's a **spread guard**: if the best and worst spot are within 8 composite
points, the differences are inside measurement noise and the agent is told to
say the room is uniformly fine rather than invent a winner.

### The agent — [`agent/run.js`](agent/run.js)

A real tool-using loop on `claude-opus-5`. The orchestrating model is given
**no image at all** — pin coordinates and numbers only — so the vision tool is
load-bearing rather than decorative; it cannot shortcut around it.

| Tool | What it does |
|---|---|
| `analyze_room_photo` | Separate vision call → named zones with `bbox_pct` + confidence |
| `score_spots` | Deterministic scoring and ranking for one activity profile |
| `pin_zone_proximity` | Which measured pin sits in which zone |
| `finalize_recommendations` | Validating sink — rejects unknown pins, missing categories |

What the model actually decides: which zone suits which activity, and how to
trade "what's visually here" against "how it measured" per activity. That's the
judgement a plain if/else can't cheaply replicate.

### Degrading gracefully

1. Vision low-confidence (`< 0.4`) or failed → agent ignores zones, recommends
   on measurements alone, and says so.
2. Agent errors or exceeds 18 s → deterministic top-ranked pin per category
   with templated reasons, and a quiet note in the UI.
3. The request itself never lands → the client falls back to a local
   lowest-ping answer.

There is no path to a blank screen.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check; reports whether the agent key is present |
| `GET` | `/api/ping` | `204`, no-store — latency probe target |
| `GET` | `/api/payload?bytes=300000` | Pre-generated random bytes — throughput target |
| `POST` | `/api/upload-probe` | Upload throughput sink (unused by the MVP) |
| `POST` | `/api/recommend` | Photo + pins + samples → labelled recommendations |

No database, no auth, no session storage. The photo lives in memory for the
duration of one request and is never written to disk.
