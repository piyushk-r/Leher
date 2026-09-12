# Leher — Build Spec (AI Buildathon, 150 min, Render)

> *One photo. A few taps. Leher tells you where to sit.*
> Scoping pass complete. Everything below is decided. Build starts at Section 11's clock.
> Repo: https://github.com/piyushk-r/Leher

---

## 1. Sanity check

**Problem.** People know their Wi-Fi is bad *somewhere* in the flat. They don't know *where*, and they make real decisions — where the desk goes, where they take the standup call, where they sit to play — completely blind. The feedback loop is "call drops → get annoyed → move → maybe better?" over weeks.

**Who.** Renters and WFH people in flats where the router placement is fixed and non-negotiable. Students in hostels/PGs. Anyone who has one "dead corner" and has never confirmed it.

**Why the existing category still leaves them stuck.**

- A single bar indicator is a 5-state ordinal with no units and no memory. It cannot compare two places.
- **WiFiAnalyzer** (VREMSoftwareDevelopment, GPLv3, Android/Kotlin) is the real benchmark — live channel graphs, multi-band detection, distance estimation, mature, free. It is also strictly *more* raw capability than anything buildable in 150 minutes. Its gap is not depth, it is **translation**: it hands you −62 dBm on a channel graph and leaves you to (a) know that RSSI ≠ usable throughput — a strong link to a congested AP or a saturated ISP backhaul still ruins a call, (b) walk the room reading a graph, and (c) map "this reading" to "so sit *there*." It has no idea a desk exists.
- Install friction: APK, Android-only. A link works on any phone in the room, instantly, including the judge's.

**Genuinely useful, or gimmick?** Split the honest answer:

- The **measurement** layer is genuinely useful but *modest* — it is a small speed-test harness with spatial memory. Real value, not novel.
- The **photo** layer adds no new physics. It is pure interpretation: it turns a table of numbers into "sit at the desk, not the couch." That is a UX claim, not a technical one — and it happens to be the exact claim the whole category never makes.
- It tips into gimmick the moment it fakes precision. **The fix, in one line:** the agent must be allowed to say *"these spots all measured the same — your Wi-Fi is fine everywhere, pick for comfort,"* and must attach a confidence to every pin. Honest beats impressive.

**Three biggest risks.**

| # | Risk | Why it bites | Mitigation (built in, not hoped for) |
|---|---|---|---|
| 1 | **Probe variance > spatial signal.** Repeated probes at one spot differ more than two different spots differ. | Recommendations look arbitrary; a judge re-taps the same spot and gets a different answer. | 9 latency samples/tap (drop first), **median + MAD**, 2 throughput runs take best. Per-pin reliability score; low-reliability pins are marked re-tappable. If spread across all pins < 8 score points, the agent is instructed to say "all about the same." |
| 2 | **Render cold start + shared-CPU jitter poisons the first pin.** | Free-tier spin-up is ~30–50 s; the first measured spot looks catastrophic and the recommendation is garbage. | **Paid instance** (credits exist — use them), warm-up request on page load, one discarded warm-up probe before every tap's timed run, region set closest to the venue. |
| 3 | **Vision misreads a dim/cluttered room, or the agent call is slow.** | Wrong zone labels read as "the AI is dumb"; a 20 s stall mid-demo reads as broken. | Vision returns `confidence`; below threshold the agent drops to numbers-only. Hard 18 s timeout on the whole agent → deterministic fallback. The loading state is *designed*, not a spinner — it is the payoff beat. |

**Verdict: build it.** The concept survives, with the honesty constraint bolted on.

---

## 2. Product statement + scope lock

**Someone working from home who cannot tell which corner of their room has usable Wi-Fi → photographs the room and taps a few spots while standing at each → gets labelled recommendations pinned on their own photo → knows where to put the desk, take the call, and play, in under two minutes, from a link.**

**MVP — must work or there is no demo**

- Photo capture/upload, resized client-side
- Tap-to-drop pin on the photo, live probe per pin, visible per-pin result
- Agent producing ≥3 labelled recommendations (💼 work / 🎮 gaming / 📶 best overall) pinned on the photo with a one-line human reason each
- Deployed, reachable at one public Render URL, works in a phone browser

**Nice-to-have — cut without hesitation**

- 📞 "best for calls" as its own category (needs an upload probe)
- Confidence badge per recommendation
- Animated pin drop-in, light/dark theme
- Raw-numbers drawer

**Out of scope — do not attempt**

- Object detection with bounding boxes, any separate CV model
- Multi-room, floor plans, real-world distance math
- Saved sessions, history, comparison, accounts, any database
- Sensor-based auto-tracking, background measurement

---

## 3. Direction — three variants, one pick

| Variant | Value | Feasibility | Demo impact | Risk |
|---|---|---|---|---|
| **A. Photo + fixed categories** (work / gaming / best overall) | High — bounded, legible output | Highest: fixed schema, fixed pin count, everything validatable | Strong — three labelled pins land at once | Low |
| **B. Photo + free-text intent** ("I mostly do video calls") parsed by the agent | Highest ceiling — feels smart | Medium: unbounded output, needs typing mid-demo, harder to validate | Good but slower; a typing beat kills a 60 s script | Medium-high |
| **C. Numbers only, no vision** | Lowest — it is a speed test with pins | Trivial | Weak — no room understanding, no differentiation | Lowest |

**Pick: A.** Fixed categories mean the output schema is known in advance, so it can be strict-validated, and a failure is recoverable into a templated card instead of a blank screen. B's free-text step costs a typing beat in a 60-second demo and makes the output unvalidatable — exactly the wrong trade when judging is live. And critically, **we get C for free**: C is not a competing product, it is the built-in degradation path when vision fails. Ship A, inherit C's reliability.

---

## 4. Photo flow, tap-to-measure, grid

**Decision.** Capture with a plain `<input type="file" accept="image/*" capture="environment">` — on mobile browsers that opens the camera directly, so no custom camera UI is built. On change, draw to an offscreen canvas, **resize longest edge to 1024 px, export JPEG at q0.72** (~120–180 KB, ~1,050 vision tokens), keep the data URL in memory only. The photo renders at full container width; an absolutely-positioned overlay `div` catches taps. Each tap drops a DOM pin and stores coordinates as **fractions of the displayed image (0–1)**, never raw pixels — that makes them resolution-independent, so the results screen redraws the same pins correctly at any width and the agent reasons in the same 0–100% space as the vision zone boxes. Coordinates are for *visual placement and zone proximity only* — no floor-plan math, no distance estimation, no scale. Each tap: pin appears immediately in `measuring` state with a pulse, probe runs ~3.5 s, pin settles into a soft colour ring (calm gradient, not red/green). **Target 5–6 taps; "See my results" enables at 3.**

---

## 5. Agent design

One real agent, server-side, a handful of tools, called once after the user taps "See my results."

### Tools

| Tool | Kind | Input | Returns | Why it is a real tool |
|---|---|---|---|---|
| `analyze_room_photo` | LLM (vision sub-call) | `{}` — photo is in session context | `{zones:[{label, bbox_pct, confidence, note}], overall_confidence}` | Side-effecting API call; the model cannot produce this from the text context it was given |
| `score_spots` | Deterministic | `{profile: "work" \| "gaming" \| "balanced"}` | Per-pin `{median_rtt, jitter, mbps, latency_score, jitter_score, throughput_score, composite, reliability}` + ranking + `spread` | Arithmetic over 9 samples × N pins — the model should never do this in its head |
| `pin_zone_proximity` | Deterministic | `{}` | Per pin: containing zone, nearest zone, distance as % of image diagonal | Geometry |
| `finalize_recommendations` | Validating sink | `{recommendations:[{category, pin_id, reason, confidence}]}` | `{ok:true}` or a validation error the model must fix | Enforces the output contract; `strict: true`, unknown `pin_id` or category is rejected and the model retries |

### Reasoning loop

1. Server assembles the user turn: the resized photo as an `image` block + a compact text block with pin ids, their 0–100% coordinates, and raw sample arrays.
2. The model's first turn typically emits **`analyze_room_photo` and `score_spots` in parallel** — they are independent. (Parallel tool use is on by default; return all `tool_result` blocks in a single user message.)
3. Model calls `pin_zone_proximity` once zones exist.
4. **The combination step is the model's own reasoning** — the part no if/else replicates: trading "what is visually in this spot" against "how it actually measured," per activity.
5. Model calls `finalize_recommendations`. Server validates; on rejection the model corrects and re-calls.

**Worked example.** The photo shows a desk in the upper-left (zone `workspace`, conf 0.82) and a TV/seating area on the right (zone `seating`, conf 0.77). Pin 3 sits inside `workspace`: 24 ms median RTT, 4 ms jitter, 41 Mbps. Pin 1 sits inside `seating`: 38 ms RTT, 11 ms jitter, 68 Mbps. → **Work = Pin 3** ("Steady and low-latency right at your desk — calls won't stutter"). **Gaming = Pin 3 too**, because gaming weights jitter at 0.40 and Pin 1's 11 ms jitter costs it more than its extra throughput wins. **Best overall = Pin 1** ("Fastest raw speeds in the room — best for streaming and big downloads"). The model *changed* the naive per-profile ranking on one category and kept it on another; that is the reasoning being visible.

### Deterministic vs. LLM — the split is explicit

| Deterministic (server, no LLM) | LLM decides |
|---|---|
| Running probes, medians, MAD/jitter, Mbps | Reading the room photo into named zones |
| All three sub-scores and every composite | Which zone maps to which activity |
| Per-profile ranking of pins | Trading zone-fit against measured score per activity |
| Pin↔zone geometry | Whether vision confidence is good enough to use at all |
| Reliability flags, spread threshold | The one-line human reason on each card |

### Graceful degradation — three layers

1. **Vision weak or failed** → `analyze_room_photo` returns `{zones:[], overall_confidence:0, error}`. System prompt: *if `overall_confidence < 0.4`, ignore zones entirely and recommend on measurements alone; say so plainly in the reasons.* The result still has all three pins.
2. **Agent errors or exceeds 18 s** → server returns the deterministic result: top-ranked pin per profile with templated reasons, `mode:"numbers"`. UI shows a quiet one-line note, not an error.
3. **Everything fails** → "best overall" pin from raw composite. Never a blank or broken screen.

**Where it runs.** Server-side in the same Render service, `POST /api/recommend`, one call per session.

---

## 6. Technical architecture

**One Node 20 + Express process. No bundler, no build step, no framework.** Express serves `public/` statically and exposes the API. Vanilla JS + hand-written CSS — this buys back ~15 minutes of Vite/config time and removes a whole class of deploy failure. Polish comes from CSS, not from React.

```
leher/
  server.js          Express: static + all endpoints
  agent/
    tools.js         score_spots, pin_zone_proximity (pure functions)
    vision.js        analyze_room_photo implementation
    run.js           tool runner setup, system prompt, timeout, fallback
  public/
    index.html  app.js  styles.css
  package.json       "start": "node server.js"
```

**Endpoints**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `200 {ok:true}` — Render health check |
| GET | `/api/ping` | `204`, `Cache-Control: no-store`, empty body — latency probe target |
| GET | `/api/payload?bytes=300000&cb=<rand>` | Random bytes, `no-store` — download throughput target |
| POST | `/api/recommend` | `{photo, pins:[{id, x, y, samples:{rtts, runs}}]}` → `{mode, recommendations:[{category, pin_id, x, y, reason, confidence}], zones, metrics, degraded}` |
| *(nice)* POST | `/api/upload-probe` | Sink for a 300 KB POST — upload throughput, enables the 📞 calls category |

**LLM call (Node SDK).**

```js
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

const client = new Anthropic({ timeout: 18_000, maxRetries: 1 });

const final = await client.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 4096,
  output_config: { effort: "low" },        // latency matters more than depth here
  tools: [analyzeRoomPhoto, scoreSpots, pinZoneProximity, finalizeRecommendations],
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
    { type: "text", text: pinSummary },
  ]}],
});
```

Notes that matter: `claude-opus-5` runs adaptive thinking by default — **do not pass `budget_tokens`** (400) and do not prefill an assistant turn (400). `effort: "low"` keeps the turn fast. `strict: true` on `finalize_recommendations` guarantees schema-valid arguments. Use `betaTool` (raw JSON Schema) rather than Zod — one less dependency. Cost per demo run is ≈1,050 image tokens + ~2K text ≈ **under $0.05**; irrelevant. If rehearsal shows the round-trip too slow, swapping to `claude-sonnet-5` is a one-string change — but measure first, do not pre-optimise.

**Avoid entirely — these eat the clock.** Auth · any database or ORM · React/Vite/Tailwind build pipeline · a separate CV or object-detection model · multi-room · floor-plan math · WebSockets · queues/workers · Docker · custom camera UI · TypeScript compile step.

**Render checklist (do this in the first block, not the last)**

- Web Service, Node, Build `npm install`, Start `npm start`
- **Bind `process.env.PORT`** — `app.listen(process.env.PORT || 3000)`; hardcoding 3000 fails silently
- Health check path `/health`
- Env var `ANTHROPIC_API_KEY` set in the Render dashboard — **never committed**
- `express.json({ limit: "8mb" })` — the default 100 kb rejects the photo payload
- **Paid instance, not free** — the free tier spins down and the cold start wrecks both the demo and the measurements
- Region closest to the demo venue

---

## 7. UX flow and visual design

**Palette.** Off-white ground `#FAF8F5`, ink `#1C1C1E`, muted `#6B6B70`, one accent gradient teal→indigo `#4FD1C5 → #6366F1`. Radii 16–20 px. 8 px spacing scale. System font stack. Nothing red or green — result rings use the accent gradient at varying opacity, so "worse" reads as *quieter*, not *alarming*.

**Screen 1 — Start.** Soft illustrated room icon, headline **"Where should you sit?"**, sub: *"Take a photo of your room. We'll test your Wi-Fi at a few spots and tell you where to sit."* One primary button: **Take a photo of your room**. Small reassurance line: *"Your photo stays in this session — we don't store it."*

- *Empty:* this is the empty state. *Loading:* button → "Getting your photo ready…" while resizing. *Error:* upload/decode fails → "That image didn't load. Try another photo." + retry, nothing else changes.

**Screen 2 — Measuring.** Photo fills the viewport. Floating instruction chip: *"Stand where you want to test, then tap that spot."* Tap → pin appears instantly with a pulsing ring → settles into a soft dot after ~3.5 s. Bottom bar: running counter *"4 spots measured — tap a few more, or see results"*, and **See my results** (disabled with a calm hint until 3 taps).

- *Empty:* 0 pins, chip visible, button disabled with *"Tap at least 3 spots"*. *Loading:* per-pin pulse, never a full-screen blocker — other taps stay possible. *Error:* a probe fails or times out → that pin goes hollow with a small ↻ and the tooltip *"Couldn't measure here — tap it again"*; it is excluded from scoring and the counter does not count it.

**Screen 3 — Results.** Same photo, same coordinates, now with three labelled pins — 💼 work, 🎮 gaming, 📶 best connection — as small friendly badges, **not numbers**. Below: one soft card per recommendation, *"Great for work — steady connection near your desk."* A collapsed **"See the numbers"** row expands into a plain table for anyone curious.

- *Loading:* the payoff beat — photo dims slightly, pins stay visible, copy cycles *"Looking at your room…" → "Comparing your spots…" → "Picking the best seats…"*. Designed, not a spinner.
- *Error / degraded:* agent or vision failed → numbers-only pins render with a quiet italic line *"We couldn't read the room this time, so this is based on your measurements alone."* Never blank.

---

## 8. Measurement algorithm

1. **On tap**, drop the pin at fractional `(x, y)` and mark it `measuring`.
2. **Warm-up:** one un-timed `GET /api/ping`, discarded — absorbs TLS/connection setup and any cold-start cost.
3. **Latency:** 9 sequential `GET /api/ping` (`cache: "no-store"`), timed with `performance.now()`. Drop the first. `median_rtt` = median of 8; `jitter` = median absolute deviation.
4. **Throughput:** 2× `GET /api/payload?bytes=300000&cb=<rand>`, fully read via `arrayBuffer()`. `mbps = bytes*8/1e6/seconds`; take the **better** of the two runs (best-of estimates capacity; median under-reports due to TCP slow-start). ~3.5 s total per tap.
5. **Reliability:** `reliability = 1 − clamp(MAD / median_rtt, 0, 1)`. Below 0.5 → mark the pin re-tappable and exclude it from ranking.
6. **Sub-scores** (0–100, all deterministic): latency ≤30 ms→100, ≥250 ms→0, linear. Jitter ≤5 ms→100, ≥60 ms→0, linear. Throughput `100 · log10(clamp(mbps,1,30)) / log10(30)`.
7. **Profile composites:** work `0.35·lat + 0.30·jit + 0.35·thr` · gaming `0.45·lat + 0.40·jit + 0.15·thr` · balanced `0.30·lat + 0.25·jit + 0.45·thr`. Rank pins per profile.
8. **Spread guard:** if `max(composite) − min(composite) < 8` across pins, flag `spread: "flat"` — the agent is instructed to say the room is uniformly fine rather than invent a winner.
9. **Vision, once:** the photo goes through `analyze_room_photo` → named zones with `bbox_pct` in 0–100% and a confidence.
10. **Match:** each pin → containing zone, else nearest zone by edge distance as % of image diagonal.
11. **Combine (LLM):** per activity, weigh zone-fit against measured rank; pick one pin per category with a one-line reason.
12. **Fallback:** zones absent or `overall_confidence < 0.4` → rank on step 7 alone and say so.

---

## 9. 60-second demo script

| Time | Beat |
|---|---|
| 0:00–0:07 | **Hook, to camera:** "Your Wi-Fi is worse in some corner of your house. You've never known which one." |
| 0:07–0:12 | "One photo. A few taps. Leher tells you exactly where to sit." Open the live URL on a phone. |
| 0:12–0:20 | Tap **Take a photo** — shoot the actual room, live. Photo fills the screen. |
| 0:20–0:42 | Walk and tap, narrating each: *"…at the desk…"* tap · *"…on the couch…"* tap · *"…kitchen counter…"* tap · *"…far corner by the window…"* tap. Each pin pulses then settles. Counter climbs to 4–5. |
| 0:42–0:46 | Tap **See my results**. |
| 0:46–0:53 | **The agent call runs live** — do not hide it. Copy cycles: "Looking at your room… Comparing your spots…" Narrate over it: *"It's reading the room and the measurements together."* |
| 0:53–0:60 | Photo redraws: 💼 at the desk, 🎮 by the couch, 📶 on the counter. Read one card aloud verbatim: *"Great for work — steady connection near your desk."* Close: **"Every other tool gives you a number. This one gives you an answer."** |

**Rehearsal rules.** Hit the URL once before going on stage (warms the instance). Pick spots that are *genuinely* far apart — near the router and a far corner — so the spread is real. Keep a backup room photo on the phone in case live capture fumbles.

---

## 10. Differentiation

**WiFiAnalyzer** (VREMSoftwareDevelopment, open-source, GPLv3, Android/Kotlin) is the honest benchmark and it beats us on raw RF depth — live channel graphs, 2.4/5/6 GHz detection, distance estimation from RSSI, years of maturity. **We will not out-analyse it in 150 minutes and should not pretend to.** It has zero AI, and it has never seen your room.

The gap we win on is the one that category has never touched: Leher looks at the user's actual room, understands what is in it, combines that with **real measured latency and throughput** (never RSSI — no browser on any OS exposes signal strength, and we never claim otherwise), and returns a plain-language answer *per activity*, pinned on their own photo, at a link with no install. WiFiAnalyzer tells you the spectrum is congested. Leher tells you to move the desk.

---

## 11. Final spec

- **Product Name:** **Leher** (*lehar* — wave)
- **One-liner:** Photograph your room, tap a few spots, and an AI agent tells you where to sit for work, gaming, and the best connection — pinned right on your photo.
- **Target user:** WFH renters, students, anyone with one dead corner and a fixed router.
- **Core problem:** People experience Wi-Fi as a vague feeling, not a map. Every existing tool hands them numbers and leaves the decision to them.
- **Core insight:** The hard part was never measuring — it is translating a measurement into a decision about a *place*, and a place only means something once you can see what is in it.
- **MVP:** §2 · **User flow:** §7 · **Architecture:** §6 · **Measurement:** §8 · **Agent:** §5 · **UX:** §7 · **Risks:** §1
- **Deployment:** one Render Web Service (paid instance), Node 20, start `npm start`, port from `process.env.PORT`, health check `/health`, secret `ANTHROPIC_API_KEY`, body limit 8 MB. Endpoint contract in §6. Agent/vision failure or >18 s → deterministic numbers-only result with a quiet note.

### 150-minute build plan

| Block | Min | Cumulative | Work |
|---|---|---|---|
| 1 | **15** | 0–15 | Scaffold Express + `public/`, `/health`, `/api/ping`, `/api/payload`. Push to GitHub. **Create the Render service and deploy.** Confirm the live URL returns `/health` from a phone. *Deploy first — the single highest-value block.* |
| 2 | **20** | 15–35 | Client probe engine: warm-up, 9-ping latency, 2-run throughput, median/MAD/Mbps. Verify against the **deployed** URL on a real phone, not localhost. |
| 3 | **25** | 35–60 | Photo capture + client resize/compress + overlay, tap-to-pin with fractional coords, per-pin measuring/settled/failed states, counter, enable-at-3. |
| 4 | **30** | 60–90 | Agent: `score_spots` + `pin_zone_proximity` pure functions, `analyze_room_photo` vision call, tool runner + system prompt, `finalize_recommendations` with `strict`, 18 s timeout + deterministic fallback, `POST /api/recommend`. **Deploy and test live end-to-end.** |
| 5 | **15** | 90–105 | Results screen: redraw pins with category badges, reason cards, "See the numbers" drawer, degraded-mode note. |
| 6 | **20** | 105–125 | Polish pass: palette, spacing, copy, all empty/loading/error states, the loading-beat copy cycle, mobile layout check at 390 px. |
| 7 | **10** | 125–135 | Full rehearsal on a real phone in the real room. Tune score thresholds against actual spread. Warm the instance. |
| 8 | **15** | 135–150 | Buffer + final deploy + second rehearsal. |

**If the clock slips**, cut in this order: "See the numbers" drawer → animations → the third category (ship work + best overall only). Never cut the deploy block, the fallback path, or the rehearsal.

### Future improvements

📞 "best for calls" with a real upload probe · confidence badge per pin · session history and before/after comparison (did moving the router help?) · multi-room · true object bounding boxes drawn on the photo · a shareable result link.
