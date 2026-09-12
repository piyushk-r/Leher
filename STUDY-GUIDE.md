# Leher — 5-Minute Study Guide

Read this right before you present. Live URL: **https://leher-82e5.onrender.com**

---

## 1. The pitch (memorise this)

> **"Your Wi-Fi is worse in some corner of your house. You've never known which one.
> One photo. A few taps. Leher tells you exactly where to sit."**

Close with: **"Every other tool gives you a number. This one gives you an answer."**

---

## 2. What it does, in one breath

Photograph your room → tap a few spots on the photo while standing at each →
it runs a real network probe at every tap → an AI agent reads the room *and*
the measurements together → labelled recommendations pinned on your own photo
(💼 work, 🎮 gaming, 📶 best connection), plus a verdict on what every single
spot is good for.

---

## 3. Demo running order (60 seconds)

| Beat | Do this |
|---|---|
| 0:00 | Hook line, to the room. Open the URL **already warmed**. |
| 0:12 | Tap **Take a photo** — shoot the actual room, live. |
| 0:20 | Walk and tap 4–5 spots, narrating: *"at the desk… on the couch… far corner…"* |
| 0:42 | Tap **See my results**. |
| 0:46 | **Let the agent call run visibly.** Narrate: *"it's reading the room and the measurements together."* |
| 0:53 | Photo redraws with labelled pins. Read one card aloud. Close with the line. |

**Before you go on stage:**
1. **Open the URL once** — free plan sleeps after ~15 min, cold start is 30–50s.
2. **Don't run it twice inside a minute** — rate limit, drops to numbers-only.
3. Pick spots genuinely far apart (near router vs far corner) so the spread is real.
4. Have a backup room photo in your camera roll in case live capture fumbles.

---

## 4. How it works — the 30-second version

**One Node + Express process on Render. No bundler, no framework, no database.**

```
Browser                          Server
  photo → resize 640px      →    /api/recommend
  tap → 9 pings + transfer  →    /api/ping, /api/payload
                                   ├─ deterministic scoring  (no LLM)
                                   └─ agent loop  (3 tools)
```

**Deterministic half (`agent/metrics.js`)** — median RTT, MAD-based jitter,
best-of throughput, three 0–100 sub-scores, weighted composite per activity,
ranking, pin↔zone geometry, and the capability classifier. **The LLM computes
none of this.**

**Agent half (`agent/run.js`)** — decides which zone suits which activity, how
to trade "what's visually here" against "how it measured", and the wording.

---

## 5. The agent — this is what gets judged

**Three tools, called in a real loop:**

| Tool | What it does |
|---|---|
| `analyze_room_photo` | Separate vision call → named zones + confidence + which spot sits in which |
| `score_spots` | Deterministic ranking for all three profiles at once |
| `finalize_recommendations` | Validating sink — rejects unknown pins, missing categories |

**The strongest thing you can say:** *"The orchestrating model is given **no
image at all** — only pin coordinates and numbers. So the vision tool is
load-bearing, not decorative. The model physically cannot answer without
calling it."*

**Two models on purpose:** `qwen/qwen3.8-27b` for vision (the only free-tier
model that reads images *and* calls tools), `openai/gpt-oss-120b` for the
orchestrator. Groq meters rate limits **per model**, so splitting them gives
each its own budget — and it costs nothing, because the orchestrator is
text-only by design.

**Worked example to quote:** *"The desk tested lowest and steadiest, so that's
the work pick. The couch had higher raw throughput but more jitter — gaming
weights jitter at 0.40, so the desk still won there, while the couch took best
overall connection."*

---

## 6. Hard questions, honest answers

**"Isn't this just a speed test?"**
The measurement layer is a speed test with spatial memory — that part is
modest and I'd say so. The differentiator is turning a table of numbers into a
decision about a *place*: "sit at the desk, not the couch." No tool in this
category does that because none of them has ever seen your room.

**"Is it reading Wi-Fi signal strength?"**
**No — and never claim it does.** No browser on any OS exposes RSSI; that's an
OS-level restriction. We measure actively-probed latency, jitter and
throughput. That's arguably more honest anyway: a strong signal to a congested
router still ruins a call.

**"WiFiAnalyzer already does this."**
It's the real benchmark and it beats us on RF depth — channel graphs, multi-band,
distance estimation, years of maturity. We will not out-analyse it. It has zero
AI and has never seen your room. It tells you the spectrum is congested; Leher
tells you to move the desk. Also: a link, no install, any phone.

**"Couldn't an if/else do this?"**
The ranking, yes — that's deliberately deterministic. What an if/else can't do
is look at a photo, decide the rectangle in the corner is a desk rather than a
sideboard, and then weigh that against how it measured, per activity.

**"What if the AI gets it wrong?"**
Three degradation layers, none of which reach a blank screen:
1. Vision confidence < 0.4 → ignore the room, recommend on measurements, say so.
2. Agent errors or exceeds 25s → deterministic ranking with templated reasons.
3. Request never lands → client falls back to a local lowest-ping answer.

**"How do you know the differences aren't just noise?"**
That's the **spread guard**, and it's the honesty feature. If the best and
worst spot are within 8 composite points, the agent is *required* to say "your
Wi-Fi is fine everywhere, pick for comfort" rather than invent a winner.

---

## 7. Numbers worth having ready

| | |
|---|---|
| Probe per tap | warm-up discarded, 9 pings (first dropped), median + MAD jitter |
| Throughput | adaptive 300KB → 2MB until a transfer exceeds 0.25s |
| Why adaptive | 300KB on a fast link finishes in ~2ms — that measures RTT, not bandwidth |
| Agent run | 3 turns, **~3 seconds**, ~4,400 tokens orchestrator + 2,531 vision |
| Photo | 640px, ~60KB, in memory only — never stored |
| Deploy | Render free, Singapore, ~30s build |

**Activity thresholds** (why a spot is "good for" something): video calls need
~3 Mbps / <30ms jitter / <200ms; gaming <80ms and <20ms jitter; HD 6 Mbps;
4K 25 Mbps. Published requirements, not invented.

---

## 8. Known weak spots — own them before they're found

- **Validated mostly against a synthetic test image**, not many real rooms.
  Zone quality on a cluttered, dim room is genuinely unproven.
- **The model still slightly understates weak spots** — a 66ms spot that
  genuinely supports gaming got called "basic use". It no longer contradicts
  the measured capability list outright, which was the real bug.
- **Free-tier rate limit** is the biggest live-demo hazard. One run fits;
  two inside a minute don't. Groq Dev Tier removes it.
- **Free Render instance sleeps.** Warm it before presenting.
- **Auto-deploy isn't wired** — the service was created via API, so GitHub's
  webhook doesn't exist. Pushes don't deploy themselves.

---

## 9. If something breaks on stage

| Symptom | What to say / do |
|---|---|
| Slow first load | "Free tier, it's waking up." Keep talking. |
| Results say *"based on your measurements alone"* | That's the fallback working — say so, it's a feature not a crash. |
| All spots look the same | Say the spread guard fired: the room is genuinely uniform. Honest, and it's the design working. |
| A pin shows ↻ | Tap it again — that spot failed to measure and is excluded from scoring. |
| Total failure | Fall back to talking through the architecture. The repo is the artefact. |

---

**Repo:** https://github.com/piyushk-r/Leher · **Spec:** [SPEC.md](SPEC.md)
