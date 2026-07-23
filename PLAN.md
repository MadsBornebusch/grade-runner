# Grade Runner — Project Plan

> An ultra-marathon pacing web app. Upload a course GPX, get a sustainable
> grade-adjusted pacing plan (splits + finish time) constrained by your aerobic
> ceiling **and** your fuel/energy balance. Plus an analysis mode that replays a
> real run's energy balance and flags bonk risk.

**Status:** Design complete, not yet implemented. This doc is self-contained —
you can resume the build from scratch on any machine using only this file. (All
equations were extracted from the Minetti 2002 paper; you do **not** need the PDF
to continue.)

**Name:** Grade Runner (chosen). **Delivery:** Vite + React + TypeScript,
containerized with Docker so it runs with no local dependency setup.

---

## 1. Vision / requirements

From the user:

1. Browser app to find pacing for ultra marathons given a GPX file.
2. Use Minetti et al. 2002 energy-cost data for uphill/downhill running.
3. Find the **sustainable grade-adjusted pace** given calorie intake per hour and
   energy used when running.
4. Let the user input **LT1, LT2, and fat oxidation at different paces**; use these
   to find the sustainable pace.
5. Must be useful **without** that data — make sensible default assumptions.
6. **Analysis mode**: input the GPX of an actual run and see the energy balance
   during the race.
7. Cool name (→ "Grade Runner").
8. There should be some grade (or speed) at which we switch from running to
   walking — research-backed (see §6).

---

## 2. The science (extracted from Minetti et al. 2002, J Appl Physiol 93:1039–1046)

Gradient `i` is dimensionless = rise / horizontal-run (e.g. 0.10 = 10% grade).

**Energy cost of running** per unit distance (J·kg⁻¹·m⁻¹), valid −0.45 ≤ i ≤ 0.45:

```
Cr(i) = 155.4·i⁵ − 30.4·i⁴ − 43.3·i³ + 46.3·i² + 19.5·i + 3.6     (R² = 0.999)
```
- `Cr(0) = 3.6` (flat). Minimum ≈ 1.7–1.8 around **i ≈ −0.10 to −0.20** (gentle
  downhill is genuinely cheapest — this is correct, not a bug).

**Energy cost of walking** (J·kg⁻¹·m⁻¹):

```
Cw(i) = 280.5·i⁵ − 58.7·i⁴ − 76.8·i³ + 51.9·i² + 19.6·i + 2.5     (R² = 0.999)
```
- `Cw(0) = 2.5`. Note Cw < Cr per-meter at almost all gradients, but walking is
  **speed-limited** (~2 m/s max) — that's what makes the walk/run choice non-trivial.

**Max sustainable speed at gradient i:** `v_i = Ė_submax / Cr(i)`
where `Ė_submax` = sustainable **net** metabolic power (W/kg).

**Sustainable fraction of aerobic power vs event duration** (Saltin):
`fract = (940 − t_min) / 1000`. ⚠️ Goes negative past ~15.6 h — **replace** for
ultras (see §5, P0 fix).

**Altitude correction** (Cerretelli), fraction of VO₂max available at altitude `alt` (m):
`fract_altitude = 1 − 11.7e-9·alt² − 4.01e-6·alt`
(≈0.94 at 2000 m, ≈0.80 at 4000 m). Apply **per-segment** using each point's elevation.

**O₂ energy equivalent:** ~20.9 kJ per L O₂ (RER 0.96). Note this is the carb value;
fat ≈ 19.6 kJ/L (see §5, P1). 1 MET ≈ 3.5 ml O₂·kg⁻¹·min⁻¹ ≈ 1.22 W/kg.

---

## 3. Tech stack & architecture

- **Vite + React + TypeScript** SPA. All computation client-side (no backend).
- **Charts:** Recharts (downsample rendered series to ~800 pts; keep full-res data
  for math). Consider uPlot if perf becomes an issue on big GPX files.
- **GPX parsing:** parse XML directly (`DOMParser`) or `@tmcw/togeojson`; extract
  lat/lon/ele/time.
- **State:** local component state / lightweight store (Zustand if it grows).
  Persist inputs to `localStorage`. No accounts.
- **Docker:** multi-stage build (node → build static bundle; nginx to serve).
  `docker compose up` → app on `localhost:8080`. Works offline once built.

### Proposed file structure
```
grade-runner/
  src/
    model/
      minetti.ts      # Cr(i), Cw(i); clamp ±0.45 + linear vertical-cost extrapolation beyond
      energetics.ts   # net↔gross, VO2↔power, Joule bookkeeping, unit constants
      substrate.ts    # logistic carb-fraction fC(x), fat ceiling, glycogen/gut simulation
      ceiling.ts      # duration→fraction curve, LT2 cap, altitude, optional durability drift
      solver.ts       # walk/run mode choice, forward simulation, bisection on effort θ
    gpx/
      pipeline.ts     # parse → smooth ele (distance window) → resample fixed 3D distance → gradient window → pause detect
    ui/               # upload, profile chart, pace/HR/fuel charts, inputs panel, mode toggle
    App.tsx
  Dockerfile
  docker-compose.yml
  nginx.conf
```

---

## 4. The two modes

### Planning mode
1. Upload **course** GPX → pipeline (parse, smooth elevation, resample to fixed
   distance, compute windowed gradient, clamp to ±0.45).
2. Solve for the sustainable plan (see §5): choose a single effort knob `θ`,
   forward-simulate the whole course, bisect θ to the largest value that keeps
   glycogen above reserve everywhere and power ≤ ceiling.
3. Output: per-segment pace & mode (run/walk), cumulative time, predicted finish,
   split table, elevation profile with pace overlay, fuel/glycogen curve, and the
   distance/time where a bonk would occur if under-fueled.

### Analysis mode
1. Upload GPX of an **actual run** (needs timestamps).
2. Reconstruct per-segment speed → metabolic power → carb/fat split → glycogen
   depletion given the user's fueling.
3. Output: energy-balance timeline (glycogen remaining, cumulative carb deficit,
   fat vs carb contribution), moving vs elapsed time, and a bonk flag with the
   point it happened / would have happened.
4. Handle pauses (auto-detect low speed / time gaps → resting metabolism, excluded
   from moving pace but counted in elapsed time and fuel absorption).

---

## 5. Physiological model — final design (with corrections)

The core structural decision from model review: **don't algebraically "intersect"
the aerobic and fuel constraints — simulate, then bisect.** Aerobic limit is an
instantaneous power cap; fuel is a cumulative reservoir with a flow limit, so it
must hold at *every* instant, not just at the finish.

**Solver:**
1. One scalar effort knob `θ` = target fraction of the (grade- & altitude-varying)
   aerobic ceiling. `P_target(seg) = θ · P_ceiling(seg)`.
2. Forward-simulate the course at θ: speed → power → carb/fat split → deplete
   glycogen (with gut inflow) → accumulate time.
3. Feasible iff power ≤ ceiling everywhere (guaranteed if θ ≤ 1) **and**
   glycogen(t) ≥ reserve for all t.
4. **Bisect on θ** for the largest feasible value → that's the plan. This auto-resolves
   the duration↔pace↔fraction↔glycogen coupling that no closed-form intersection can.

**P0 corrections (must-do):**
- **Net vs gross consistency.** Minetti Cr is *net* (rest subtracted). VO₂max ceiling
  is *gross*. Add resting metabolism `P_rest ≈ 1.2 W/kg`; use gross everywhere:
  `P_gross = Cr(i)·v + P_rest`; ceiling `P_ceiling = fract · VO2max · 20.9/60` (W/kg, gross).
- **Replace Saltin fraction** (goes negative for long ultras) with bounded decay:
  `fract(t) = f_inf + (f0 − f_inf)·exp(−t/τ)`, defaults `f0 = 0.94`, `f_inf ≈ 0.38`,
  `τ ≈ 250 min`. Always cap by LT2. Let the user calibrate to one recent race.
- **Fuel = reservoir + flow limit, in grams.** Track glycogen forward:
  `dGly/dt = carb_in_ox − carb_demand`, floored at reserve (0 by default --
  restructure session: not user-editable, see §7). Exogenous carb is
  `carb_in_ox = intake_g_per_h` directly -- **no gut-absorption cap is
  modeled** (restructure session removed the earlier `min(intake, gut_max)`
  version); the UI instead tells the user what's realistic (~60 g/h
  glucose-only, up to ~90 g/h glucose+fructose) so planning far above that
  doesn't silently overstate how much carb is actually usable.
  Bonk = glycogen hits reserve → sustainable power collapses to `fat_ceiling + exogenous_carb`.

**Fat oxidation — energy-conserving default (P1).** Model the substrate split as a
**carbohydrate energy fraction** (conserves energy by construction), then apply an
absolute fat-rate ceiling on top. With `x = %VO2max`:
```
fC(x) = 1 / (1 + exp(−k·(x − x0)))
```
Anchored to thresholds (defaults LT1 = 0.65, LT2 = 0.85 of VO₂max):
- `x0 = LT1` (so fC(LT1) = 0.5)
- `k = ln(9) / (LT2 − LT1) ≈ 11`  (so fC(LT2) ≈ 0.9)

Then `carb_rate = fC(x)·P_gross`, `fat_rate = (1−fC(x))·P_gross`, subject to
`fat_rate ≤ FO_peak·37.7 kJ/g` (default `FO_peak ≈ 0.55 g/min`, elites ~1.0). If fat
is capped, the shortfall is forced onto carbs — this is the mechanism that makes hard
efforts glycogen-expensive and drives the bonk.
- **User fat-ox data:** convert each (intensity, g/min) point to an energy fraction;
  ≥3 pts → fit `(x0,k)` or monotone PCHIP on fC; 1–2 pts → shift/scale the default logistic.

**Other P1/P2 corrections:**
- **Beyond ±0.45**, don't extrapolate the polynomial (it explodes) — clamp `i`, then
  add a linear vertical-cost term ≈ `9.81/0.25 ≈ 39 J/kg per vertical m` for climbing
  so steep pitches degrade gracefully instead of flat-lining.
- **Distance convention:** gradient uses horizontal (haversine) run; cost/speed/splits
  use **along-slope 3D distance** `run·√(1+i²)` (matches Minetti's belt distance). Pick once, be consistent.
- **Energy bookkeeping in Joules**, partition into carb-J / fat-J, convert with
  16.7 kJ/g (carb), 37.7 kJ/g (fat). (Avoids the ~4–7% O₂-equivalent inconsistency.)
- **Altitude per-segment** (Cerretelli on each point's elevation), not once globally.
- **Analysis-mode speed:** smooth speed on the same distance grid as elevation; detect
  stops (speed < ~0.5 m/s or time gaps) → resting power, no phantom movement.
- **Optional durability drift** (biggest ultra-specific effect missing otherwise):
  `Ė_sus(t) = Ė_sus·(1 − d·hours)`, off by default.

**GPX pipeline:** distance-based elevation smoothing (rolling median over a real
meters window) on the raw points *first*, then resample to fixed 3D spacing;
gradient = rise over a ~20–50 m window on the (already-smoothed) resampled grid
(never point-to-point — that's pure noise). Smoothing before resampling, not after,
matters: smoothing an already-resampled (lossily interpolated) series can't recover
detail the resample step threw away, and — the actual bug found in testing —
converting a meters window to a resampled-grid point-count radius and flooring at 1
point collapses to the *same* radius for any window smaller than ~3x the segment
length, silently making "smoothing window" a no-op across most of its practical
range while segment length ends up secretly controlling the real smoothing extent
instead. Smooth on the raw points with a genuine distance window and this doesn't
happen — the two controls stay independent regardless of point density. Report total
gain *after* smoothing; let the user calibrate smoothing/scale to a known course
vertical. Missing elevation → warn / flat-course fallback. Missing timestamps →
planning only.

**On "are we losing real information to filtering" (investigated, see also the
in-app "Course processing debug" toggle):** measured on two real recorded ultras.
Total elevation gain has no single "true" value on rough natural terrain — it climbs
roughly continuously as resolution increases with no clear noise-floor plateau in the
tested range (this is the coastline paradox: real terrain has genuine roughness at
many scales, and gain is scale-divergent by nature). But **what the model actually
uses is not gain** — `solver.ts`/`analysis.ts` consume the per-segment gradient and
`distance3D`, never `totalElevationGain`. Measuring the thing that actually drives
predictions (∫ cost(gradient)·distance, a proxy for total metabolic work) shows it's
comparatively *stable*: at a fixed, adequately-smoothed segment length, varying
`smoothingWindowM` from 10m to 300m moved the work integral only ~1.2% even though
displayed gain moved ~26%. That stability requires *adequate* smoothing, though — at
`smoothingWindowM` near 0 combined with a very fine `segmentLengthM` (chasing "less
filtering, more real detail"), gradient noise gets amplified (small elevation noise
divided by a short segment span → large spurious gradient) and Minetti's convexity
turns that into real inflation of predicted work — this is the actual bonk
sensitivity a user will hit, not the gain number moving.

**Distance is the other axis, and it's not scale-divergent the same way.** It
shrinks in a straight line as `segmentLengthM` grows, because longer resample
segments cut corners on turns/switchbacks — a real geometric effect (not noise), and
distance enters the model linearly (`time = distance / speed` every segment). On a
real 80km course, segment length 20→100m moved distance ~4.6% and predicted finish
time ~7%, *even at the same, adequate smoothing window* — this is the more
consequential number to watch, not gain. Practical takeaway: the two controls
protect different things — smoothing protects the gradient/cost calculation,
segment length protects distance fidelity — so there's no forced tradeoff between
them. A finer segment length (e.g. 20-25m) paired with an adequately large smoothing
window (not near 0) gets closer to true distance *and* keeps the cost calculation
stable; only pushing smoothing down near 0 is what actually risks bad predictions.

---

## 6. Walk ⇄ run transition — research + recommendation

The user specifically asked for literature. Findings:

- **Minetti, Ardigò & Saibene 1994**, *The transition between walking and running in
  humans: metabolic and mechanical aspects at different gradients*, Acta Physiol Scand
  150:315–323 (this is ref 21 in our 2002 paper). They measured, at each gradient, both
  the **metabolically-equivalent speed** Sm (where Cw = Cr) and the **spontaneous
  transition speed** Ss. Both **decrease as gradient increases**, and people
  spontaneously switch ~0.5–0.9 km/h *below* the metabolic-equivalence speed.
- **Level walk↔run transition ≈ 2.0 m/s (~7.2–7.6 km/h).** A gradient study
  (±5%, PMC4575035) found the energetically-optimal transition speed is ~7.5 km/h and
  barely changes over ±5% (downhill slightly faster). So near-flat, ~2 m/s is a solid anchor.
- **Practical trail heuristic:** most runners should walk once grade exceeds
  **~15–20%** (≈15° ≈ 27% for the steepest estimates); at +20–30% walking is more
  economical than running for nearly everyone; elites hold running a bit steeper.

**Recommendation (implement this — no magic grade constant):** let the transition
*emerge* from a walking-speed cap, which reproduces the literature:
```
v_run(i)  = min( P_net / Cr(i), v_descent_max(i) )   # v_descent_max = ∞ above i ≈ -0.10
v_walk(i) = min( v_walk_max , P_net / Cw(i) )        # v_walk_max ≈ 2.0 m/s
mode      = argmax(v_run, v_walk)                     # faster mode at equal power wins
```
On the flat, `v_run ≫ 2` → run. As grade steepens, `v_run` collapses below walking
speed and Cw < Cr → walk. The crossover falls out at ~15–25% grade (fitness-dependent
via P_net and `v_walk_max`), matching the studies. Expose `v_walk_max` and a
"force walk above X% grade" override as user settings.

**Descent speed cap (implemented, `model/minetti.ts` `maxDescentSpeedMs`):** Minetti's
data is metabolic cost measured on a smooth, motor-driven treadmill at an *imposed*
speed — it says nothing about whether a real trail runner can safely control their
body at the speed their aerobic budget alone would allow on a real descent. Without a
separate limit, `v_run(i) = P_net / Cr(i)` blows up right at Cr(i)'s minimum
(i ≈ −0.10 to −0.20): a large-but-plausible power budget divided by ~1.8 J/kg/m
implies sub-2:30/km paces on ordinary trail descents, which no one actually runs.
`v_descent_max(i)` is an independent, non-metabolic ceiling (braking/eccentric
control, footing, technical terrain — this *is* the "descent-fatigue penalty...
not captured by Minetti" flagged above) that only engages below i ≈ −0.10, so mild
downhill and everything else is untouched. It's a speed limit, not an added energy
cost, so it doesn't distort glycogen/fat-burn accounting (including Analysis mode,
which uses actual recorded speed and never calls this function at all). Roughly
calibrated against one recorded 55 km trail ultra's actual GPS pace vs. grade — real
signal, but a single noisy data point, not a validated constant like Minetti's own
curve. Not yet exposed as a user setting (see §7); a strong technical descender and a
cautious one likely warrant different values.

**Real-data check (2026-07-23): should walk-forcing be added? No —
it already exists and isn't needed; the real, actionable finding is that
`maxDescentSpeedMs` is measurably too conservative for this athlete.**
Prompted by a direct question ("find grades where the athlete always
walks and force Minetti walk cost there"). `forceWalkAboveGrade` already
exists (`solver.ts`, wired into `FormInputs`/`InputsPanel.tsx`, default
off) as exactly the manual override this section already recommended; the
real question was whether the *emergent*, un-forced choice already
reproduces this athlete's real gait transition, making a forced override
unnecessary. `scripts/testGaitChoiceEmergence.ts` (new; no network calls,
reads `.strava-cache/` directly) runs three independent checks — an
earlier version tried converting device power into a "predicted mode" via
the Minetti cost curves and comparing it to actual gait, but that
agreement number turned out to be near-tautological (the power→speed
conversion was calibrated using the flat-ground running relationship,
which makes "predicted mode" collapse to nearly the same speed threshold
used to define "actual mode" — measuring calibration transfer, not gait
validity). Dropped in favor of three checks that don't share that flaw:

- **(A) Ground truth, no model at all:** real walk% by grade, straight
  from GPS speed, across 65,476 segments from 250 activities. Answers the
  literal question directly: walk% rises gradually from 9% (0-5% grade)
  to 21%/45%/69% at 5/10/15%, crossing into "consistently walks" (85%+)
  at **+20% grade and beyond**, staying in the 85-96% range all the way to
  +55% (small dip to 69-71% at +60-65%, but n=13/7 there, likely noise).
  No sharp cliff — a gradual transition, exactly the shape §6's
  literature review predicted rather than a single hard threshold.
- **(B) Analytical, no device power or real data at all:** at
  representative sustainable net-power levels (6-18 W/kg), the grade
  where `solver.ts`'s own `argmax(v_run, v_walk)` formula switches to
  walk, computed directly from `costOfRunning`/`costOfWalking`. Crossover
  ranges from -3% (at 6 W/kg) up to +20% (at 18 W/kg) — bracketing almost
  exactly the same 5-30% zone where (A) shows the real gradual transition
  happening. A model that already produces a walk crossover in the same
  grade range this athlete actually transitions in, across the plausible
  range of efforts they'd actually run at, is doing its job — there's no
  gap here for a forced override to fix.
- **Conclusion: no evidence supports adding walk-forcing on climbs.** The
  existing emergent mechanism, with no override at all, already produces a
  climbing transition in the right place. (A) is real ground truth
  independent of any model; (B) is pure arithmetic independent of any real
  data — neither depends on the device-power conversion that undermined
  the first attempt, and both point the same way.

- **(C) Real, power-independent, and the actual finding worth acting
  on:** for segments where the athlete was actually *running* downhill
  (speed > walkMaxMs), compare their real GPS speed against
  `maxDescentSpeedMs(grade)` directly — no power, no calibration, just
  recorded pace vs. the model's own speed cap. Real median running speed
  **exceeds the cap at every descent grade checked**, and by a growing
  margin as descents steepen: 9% over at -15% (n=1020), 18-22% over at
  -20% to -25% (n=111-315), 34-88% over at -30% to -40% (n=7-39, thinner
  but consistent in direction). `maxDescentSpeedMs` was always flagged as
  "roughly calibrated against one recorded 55km trail ultra... a single
  noisy data point, not a validated constant" (above) — this is the first
  real check against that flag, and it says the cap is too conservative
  for *this* athlete specifically, likely because it was calibrated on a
  more technical course than their descents typically are. **This is the
  actionable follow-up from this exercise — not walk-forcing, which isn't
  needed, but recalibrating (or exposing as a real per-athlete setting,
  per §7's existing note) `maxDescentSpeedMs` itself.** Not changed yet;
  flagged here as a scoped, well-evidenced next step, distinct from
  Plan B.

---

## 7. User-editable parameters & zero-input defaults

| Param | Default | Notes |
|---|---|---|
| Body mass | 70 kg | Settings |
| VO₂max | 50 ml/kg/min | Settings; or infer from a recent race |
| LT1 / LT2 (%VO₂max) | 0.65 / 0.85 | Settings; anchors fat curve + ceiling cap. Advanced: enter as pace + pulse instead (heart rate is reference-only, not fed into any calculation) |
| Duration→fraction curve | f0 0.94, f_inf 0.38, τ 250 min | Settings; found automatically from a Strava backfill+fit once it clears its own quality bar, or left at these defaults otherwise. Advanced: override manually |
| Carb intake | 60 g/h | Course page (per-race, not an athlete constant) |
| Glycogen store | 7.5 g/kg ⇒ ~525 g at 70kg | Course page, entered as g/kg (not a raw gram total) -- carb-loading or a fasted/depleted start are real per-race reasons to change this |
| FO_peak (fat rate ceiling) | 0.55 g/min | ~1.0 for elites |
| Resting metabolism | 1.2 W/kg | net→gross bridge |
| Walk max speed / force-walk grade | 2.0 m/s / off | Settings |
| Smoothing window / segment length | 150 m / 50 m | Course page; see §5 GPX pipeline note re: why 150, not 40 |
| Altitude adjustment | on | Cerretelli per-segment |
| Durability drift | off | Settings; decay Ė_sus over hours |

**Removed as user-editable (PLAN.md restructure session):**
- **Gut oxidation max.** The model now assumes all planned carb intake is
  absorbed and oxidized -- it doesn't enforce an absorption ceiling itself.
  The UI instead tells the user what's realistic (~60 g/h glucose-only, up
  to ~90 g/h glucose+fructose mixes) so they don't plan for more than a
  real gut can handle. Simpler than modeling two numbers (intake, gut cap)
  when the practical guidance is a single sensible ceiling on intake itself.
- **Glycogen reserve floor.** Defaults to 0 (kept as an overridable
  model-layer param purely for tests to exercise the floor mechanism, not
  exposed anywhere in the UI). Unlike glycogen store, there's no real way
  for an athlete to personally calibrate this -- it's a modeling floor
  (glycogen depletion is never literally complete; the liver keeps
  supplying some glucose), not a measured physiological constant, so it
  wasn't worth a dedicated input.

Everything above the fold works with zero physiology input; accuracy improves as the
user supplies LT1/LT2, fat-ox points, and a calibration race.

**UI structure (restructure session):** one-time athlete setup (mass,
VO2max, LT1/LT2, walk speed, pacing curve, Strava connect+backfill+fit)
lives in a gear-icon Settings modal, decoupled from the swipeable
Course/Results flow -- the main loop is upload a course, see the plan.
Fueling (intake, glycogen store) moved to the Course page since it's
genuinely per-race, not an athlete constant. A true mmol/L lactate-profile
+ threshold-detection input tier (beyond LT1/LT2-by-pace) was scoped and
explicitly deferred as a separate future item -- a real one needs genuine
new exercise-science logic (e.g. modified-Dmax or fixed-4mmol detection),
not reuse of anything already in the app.

---

## 8. Build steps (suggested order)

1. Scaffold Vite + React + TS. Add Recharts.
2. `model/minetti.ts` + unit tests (check Cr(0)=3.6, Cw(0)=2.5, min near −0.1..−0.2,
   clamp/extrapolation beyond ±0.45).
3. `gpx/pipeline.ts`: parse → resample → smooth → windowed gradient → pause detect.
   Test with a real GPX; verify total gain is sane after smoothing.
4. `model/energetics.ts`, `substrate.ts`, `ceiling.ts` (+ tests for net/gross, fuel
   conservation, fraction curve staying positive).
5. `model/solver.ts`: walk/run choice, forward sim, bisection. Sanity-check finish
   times against a known race.
6. UI: upload, elevation profile, inputs panel, mode toggle, split table, fuel chart.
7. Analysis mode reconstruction + energy-balance timeline.
8. Dockerfile + docker-compose + nginx; verify `docker compose up` serves the built app.

## 9. Verification

- Unit tests for all `model/*` pure functions (Vitest).
- Cr(0)=3.6, Cw(0)=2.5; Cr minimum near i≈−0.1..−0.2; energy conservation
  (carb-J + fat-J = total-J each step); glycogen never negative; fraction curve
  stays in (0,1] for 24 h+.
- End-to-end: load a real ultra GPX, produce a plan, eyeball splits/finish against a
  known result; toggle analysis mode on a run with timestamps and confirm the
  bonk/energy-balance curve is plausible.
- `docker compose up` → open `localhost:8080`, upload GPX, see a plan. Works offline.

---

## 10. How to resume on another PC

You only need this file — all equations and the model are captured above.

1. Copy this `PLAN.md` (and optionally the Minetti PDF) to the new machine.
2. Point Claude Code at it: "Read PLAN.md and start building Grade Runner from
   §8 build steps." Begin with the Vite scaffold + `model/minetti.ts` + tests.
3. Open decisions already made: name = **Grade Runner**; stack = Vite+React+TS,
   Dockerized; model = simulate-and-bisect (§5); walk/run = emergent speed-cap (§6).

---

## 11. Future work: multi-run athlete calibration ("digital twin")

**Goal** (user request): use several of the athlete's *past* GPX recordings —
plus optionally their fat/carb-ox curve — to calibrate the athlete model itself
(VO2max/LT2, the pacing-fade curve, the fat-ox curve), rather than relying on
manually-entered guesses, so a *new* course's plan is built from evidence, not
just defaults. Not yet implemented; this section is the design starting point.

### Why one race isn't enough (recap, ties to §5 pacingFit.ts)

The tau-fit already built (`pacingFit.ts`, Analysis page) hit this directly:
f0 lives inside the LT2-capped plateau and is masked once decay starts; fInf is
an asymptote a single several-hour race never reaches; tau is the one thing a
race of comparable duration actually pins. **Multiple races of genuinely
different durations is what breaks that confound** — a short race constrains
f0, a long one constrains fInf, and tau falls out of the shape connecting
them. This is the main reason a multi-run calibration is worth more than
"just fit harder on one race": it's not more data of the same kind, it's data
that resolves what one race structurally can't.

### Heart rate: what it can and can't do here (researched this session)

Three standard zone models, in increasing physiological fidelity and required
input:
- **%HRmax** — simplest (just a max HR), but a 220-age estimate is not
  accurate enough to anchor zones on, and individual max HR varies widely at
  the same fitness level.
- **%HRR (Karvonen)** — `zone = HRrest + %×(HRmax − HRrest)`. Documented as a
  solid middle ground over %HRmax without needing lab testing; still needs a
  real (not estimated) max HR and a resting HR.
- **%LTHR (threshold-anchored)** — zones as a fraction of lactate/threshold
  HR. Most consistent with how this app already thinks (LT1/LT2 as fractions
  of VO2max) since it's anchored to a *threshold*, not an estimated ceiling.
  Modern watches can auto-detect LTHR without a lab test, but validation
  studies put smartwatch LTHR at ~65% "success rate" vs. lab testing, ~11bpm
  mean error — usable, not precise.

  Sources: [Garmin HR zones explained](https://www.shoulditrain.com/blog/garmin-heart-rate-zones-explained), [%LTHR zones](https://chrismooreendurancecoaching.com/understanding-garmin-heart-rate-zones-part-3-lactate-threshold/), [smartwatch LTHR validity](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12309276/)

**The important caveat, not just a footnote:** heart rate is *not* a stable
proxy for %VO2max over ultra durations. "Cardiac drift" — HR climbing at
constant true output, driven by rising core temperature, dehydration, and
reduced stroke volume, not increased metabolic intensity — is well
documented: 10–15bpm drift is typical on a long aerobic effort, 20–30bpm in
heat/dehydration, with onset around 25km into a marathon-length effort. Source:
[cardiac drift / decoupling research](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1571498/full).

This is *the same trap* the tau-fit's advisor caveat already covers for
power/pace (a negative split and a slower fade produce the same trace) —
except for HR, the confound is worse: an upward HR trend at steady pace could
mean rising effort, or could mean nothing metabolic at all, just heat. Naively
feeding raw HR into the substrate/ceiling model as if it were %VO2max would
import this confound directly into the fitted curve. **Recommendation: use HR
mainly to build a per-athlete HR↔power/pace relationship from races that have
both (e.g. Ecotrail, which has power+HR together), fit predominantly from the
first ~60-70% of race duration where drift is smallest, and treat HR-only
races as a lower-confidence input than power- or pace-anchored ones** — not
as a direct substitute for the existing %VO2max intensity axis.

### Proposed staged architecture

1. **A run library — built.** `src/storage/runLibrary.ts` stores raw parsed
   `GpxPoint[]` + a name/timestamp per run in IndexedDB (not a derived
   summary, so nothing to migrate when the model changes — pipeline/analysis
   just re-run on demand). UI lives on the Athlete page
   (`src/ui/RunLibraryPanel.tsx`): add/name/delete runs, select a subset,
   see each one's distance/duration.
2. **Pooled tau-only ceiling fit — built.** `fitTauAcrossRaces` in
   `pacingFit.ts` extends the single-race tau search across several
   selected runs at once: each race's own within-race slope is computed
   separately and the search minimizes the *sum of squared per-race
   slopes*, not one regression over concatenated points (races run on
   different days at different average efforts, so a pooled regression
   would mostly reflect cross-race effort differences, not fatigue shape).
   The search range still scales from the shortest/longest selected
   race's own duration, not a flat constant.

   The original plan here was a joint 3D (f0, fInf, tau) search, reasoned to
   be identifiable once races span different durations. An advisor review
   caught two problems before that got built: (a) the within-race-slope
   objective is scale-invariant — a flat ceiling (`fInf = f0 = c`) zeroes
   every race's slope for *any* c, so the sustained level `c` (which is what
   actually drives Planning's finish-time predictions) is a free direction
   under this loss; fitting f0/fInf needs an added level-anchor term (e.g.
   the LT2-capped plateau at the very start of a race). (b) it needs races
   that actually span a wide duration range (roughly 2×+) to separate f0
   from fInf — the two real races used to validate this stage were both
   ~7-8.5h, so on real data today there'd be no signal for the extra two
   parameters anyway, just extra degenerate directions.

   **(a) is now resolved — `fitFInfAndTauAcrossRaces` (also in
   `pacingFit.ts`) jointly fits (fInf, tau), built after re-deriving the
   actual source of the degeneracy rather than building the originally-
   imagined loss term.** The degeneracy specifically requires f0 *and* fInf
   to move *together* (ceilingPower is exactly linear in a joint rescaling
   of both) — holding f0 fixed (exactly as the tau-only fit already does,
   not a new restriction) and searching only (fInf, tau) breaks that
   specific unbounded direction, since scaling fInf alone no longer scales
   the whole curve by a matching constant. Verified with a throwaway
   synthetic-recovery test (deleted after use, same discipline as the
   VO2max estimator's invariance check) before writing any production code
   — races built to follow a known (f0=0.94, fInf=0.55, tau=300) ceiling
   exactly, fit with f0 held fixed:

   | Scenario | Recovered fInf (true 0.55) | Recovered tau (true 300) |
   |---|---|---|
   | Durations [60, 180, 360, 600, 900] min (wide spread) | 0.560 | 300 (exact) |
   | Durations [420, 450, 480, 510] min (clustered) | 0.530 | 340 |
   | Single 900min race only | 0.530 | 420 |

   No scenario ran away to a search boundary — confirms fixing f0 alone
   makes the *mechanism* well-posed; precision clearly degrades without
   duration diversity (matching (b) below) but gracefully, not
   catastrophically. `vo2MaxMlPerKgPerMin` is held fixed for the same
   reason f0 is (it's an equally-linear multiplier on the whole curve) —
   both are load-bearing constraints, not incidental defaults, now that
   fInf floats. The fInf search range is also bounded strictly below
   `lt2Fraction`: above it, `sustainableFraction`'s own cap makes any
   fInf ≥ lt2Fraction behave identically (flat at the cap), reopening a
   version of the same degeneracy in a different corner.

   **Important framing, carried into the UI (`RunLibraryPanel.tsx`'s
   "Experimental" section) and worth restating here:** this makes the fit
   *runnable*, it does not give fInf independent empirical grounding.
   `vo2MaxMlPerKgPerMin` (from the VO2max estimator or manual entry), `f0`
   (a manual constant), and `fInf` (the thing being fit) are three coupled
   quantities — fInf comes out relative to whatever the other two
   currently are, and absorbs error in both. A real empirical anchor
   (tying the model to *observed* early-race power via an actual new loss
   term — the originally-imagined fix for (a)) is a separate, larger piece
   of work, deliberately deferred; it would give f0/VO2max themselves
   genuine grounding, which this doesn't attempt.

   (b) is unblocked but not resolved by data yet: `suggestRunsForFit`'s
   `durationSpread` bucket (`suggestRuns.ts`) surfaces candidates for the
   duration range this fit needs (the single longest available race plus
   others at least ~2x shorter), and the new fit reports
   `durationDiversityRatio` directly so the UI can flag when today's
   result is a rough guess rather than a firm number.
3. **HR↔power/pace calibration — built, scope narrowed after exploration.**
   The original framing ("lets a future HR-only run with no footpod get an
   effort estimate") turned out to already not apply to the common case:
   `analyzeRun` always derives `grossPowerWPerKg` from GPS pace + gradient
   via the Minetti cost curve, never from a device's own recorded power --
   so a normal GPS run never actually *needs* HR for an effort estimate.
   The only genuine "HR-only" case is a run with no GPS at all (e.g. a
   treadmill session), which the pipeline can't ingest today (hard
   requires lat/lon per point). Raised directly with the user: scope
   confirmed as **GPS runs only, no new ingestion path** -- build the
   calibration mechanism, HR zones, and a diagnostic overlay proving the
   fat-ox-curve reuse works, without inventing a treadmill/manual-entry
   format.

   `src/model/hrCalibration.ts`'s `fitHrToEffortCalibrationAcrossRaces`
   fits `effortFraction ≈ intercept + slope × heartRateBpm` via a single
   weighted least-squares regression pooling every (HR, effort) point
   across every selected race -- unlike the tau/fInf fits, this isn't a
   within-race fatigue shape, so it doesn't need their per-race-slope
   pooling trick; HR-to-effort should be a roughly stable athlete-level
   relationship across races. Restricted to the early ~65% of each race's
   own duration, per the cardiac-drift research above (10-15bpm typical
   drift over a long aerobic effort, worse in heat). Weighted by segment
   duration and by race recency, same convention as the other multi-race
   fits. `EffortTrendPoint` gained an optional `heartRateBpm` field
   (mirrors `surfaceUnpaved`) to carry HR into the fit.

   Verified with a synthetic recovery test first (known true slope/
   intercept + noise, confirms the fit recovers close to truth; a
   second test confirms points outside the early window are correctly
   excluded by corrupting them and checking the recovered slope is
   unaffected) before trusting it on real data. Auto-applies only when
   R² clears a documented (not tuned-to-pass) 0.5 bar -- a low R² is a
   legitimate result (this athlete's HR may just not track effort well),
   not a bug to work around.

   Real-data check (2026-07-22, 4 real races, downsampled for a browser
   demo -- not the full-resolution backtest the terrain multiplier got,
   since there's no equivalent "actual finish time" to validate an HR
   calibration against): effort fraction ≈ -0.914 + 0.0116 × heart rate,
   R² = 0.24 from 5287 pooled points across 4 runs -- below the 0.5 bar,
   so correctly *not* auto-applied, with the UI explaining why. This is
   the honest result for a rough demo dataset, not a claim the mechanism
   is broken; a real athlete's own consistent HR data should fit better.

   **Fixed: power is now smoothed before regressing against HR.** The
   first version above compared raw per-segment power to raw per-segment
   HR -- the user pushed back on this, on physiological grounds: the
   cardiac/pulmonary response to a change in output is lagged and
   effectively low-pass filtered, not instantaneous, so a point-by-point
   comparison would wash out a real relationship whenever effort is noisy
   at short timescales (terrain variation, walk/run transitions). Checked
   directly on real full-resolution power+HR data from 3 real ultras
   (Soria Moria, Ecotrail 80, Ås Backyard): pooled R² was 0.31 at zero
   lag/no smoothing, rose only to ~0.35 with the best fixed lag on HR
   (~30s), but rose to **~0.43** when power was smoothed over a trailing
   ~60-90s window before regressing against HR -- matching published
   VO2/HR on-transient time constants (roughly 20-45s for moderate
   exercise). A "sustained effort only" filter (steady 3-minute stretches)
   pushed R² to ~0.59 but kept only ~5% of points; smoothing alone was
   judged the better production tradeoff. `hrCalibration.ts` now smooths
   `grossPowerWPerKg` over a trailing 75s window (the empirical midpoint)
   before computing effort fraction, verified with a synthetic test that
   recovers a true slope through large high-frequency power noise a raw
   comparison would be swamped by.
4. **HR zone inputs on Settings — built.** `hrZoneModel` (%HRmax / %HRR-
   Karvonen / %LTHR / custom boundaries in bpm), plus the relevant bpm
   fields per model, mirror the existing LT1/LT2-as-fraction pattern. Zone
   boundaries are resolved by `resolveHrZones` in `formInputs.ts` (standard
   5-zone %HRmax/%HRR breakpoints; Garmin's own 6-zone %LTHR scheme, per
   the same source PLAN.md already cites; user-entered boundaries for
   `custom`) and shown read-only in a new "Heart rate zones" fieldset in
   `InputsPanel.tsx`. Reference/display only, same as `lt1/lt2HeartRateBpm`
   above -- nothing here feeds ceiling or substrate calculations; the
   calibration in stage 3 is the one place HR actually drives a number,
   and it's kept deliberately separate from these zone boundaries.
5. **Fat/carb-ox curve reuse — validated, not separately built.**
   `predictEffortFractionFromHr(hr, calibration) * ceilingPower(...)` gives
   a power estimate usable anywhere pace-derived power already is,
   including `substrate.ts`'s `splitPower`/`bonkPowerWPerKg` -- both are
   already agnostic to where a power number came from, so no new
   substrate-layer code was needed. Proven two ways: a unit test feeding
   HR-calibration-derived power straight into `splitPower`, and a real
   diagnostic overlay -- `PowerHrChart` (Analysis mode) now draws a third
   "HR-calibrated power" line alongside modeled and measured power,
   verified in a real browser against real GPS+HR+power data (Ecotrail 80)
   with no console errors. The overlay is the practical value delivered
   for GPS runs today: if the HR-derived line tracks modeled power early
   and diverges late, that's cardiac drift showing up exactly where
   expected, not a sign the calibration is wrong. A genuinely GPS-less
   (treadmill) ingestion path, which would be the other place this reuse
   could plug in, remains explicitly out of scope (see stage 3's note).

   **Follow-up: estimated heart rate on the results page — built.** The
   overlay above runs the calibration forward (HR → effort); a Planning-
   mode course has no recorded HR to run it on in the first place, so the
   useful direction there is the inverse: `predictHeartRateFromEffortFraction`
   estimates the HR this athlete would likely show at a given effort
   fraction. `ChartPoint` gained `estimatedHeartRateBpm`, computed per
   point from `grossPowerWPerKg`/ceiling when a calibration is applied
   (null otherwise); the split table gained a time-weighted "Est. HR"
   column, shown only when a calibration is configured. Verified in a real
   browser: sensible bpm estimates tracking terrain/pace across splits, no
   console errors.

Stages 1–5 are now built. Stages 1-2 work purely from power/pace data
already being parsed; stages 3-5 add HR-specific value within the scope
the user confirmed (GPS runs only) -- genuinely useful (zone awareness, an
independent effort cross-check, drift visualization) without overclaiming
a "HR-only" capability the pipeline doesn't actually support yet.

## 12. Future work: intensity-dependent fade, time-varying tracking, input provenance

**Goal** (user request): fit the *full* athlete model (VO2max, LT2, f0/fInf/tau,
durability) from a year or two of Strava history, with three specific asks:
(1) does that much data even identify the model, and does the fit need to
change to account for high-intensity races fading faster than low-intensity
ultras; (2) let the model *adapt over time* as the athlete trains; (3) let
manually-supplied values (VO2max, fat-ox points) carry a date and a
source/confidence, so a lab test outweighs a watch guess. Researched via four
literature sweeps (critical-power modeling, central/peripheral fatigue
physiology, VO2max estimation/wearable accuracy, and time-varying athlete
tracking) before designing anything — findings below, architecture after.
Nothing in this section is built yet.

### Q1: Is 1-2 years of Strava data enough?

**For tau/durability: probably yes — duration diversity is the thing that
matters, and a real training log has plenty of it.** Critical-power testing
literature (Simpson & Kordi 2017) shows 2 well-chosen durations beat 3 poorly
chosen ones; the failure mode is narrow duration *coverage* (Housh's
long-duration-only trials overestimated sustainable power by ~2x), not raw
count — exactly the lesson already learned the hard way in §5/§11's tau fits.

**For VO2max specifically: likely a real gap, and more Strava data doesn't
fix it.** VO2max is best constrained by short-to-moderate, near-maximal
efforts (the CP/W′ literature calibrates on ~2-15min trials). Race-performance
formulas degrade sharply as duration grows: at 100km, a performance-prediction
model explained only ~49% of variance without even using VO2max (Coquart et
al. 2023); at 166km, VO2max alone correlated r=-0.72 with performance and
VO2max+economy explained just 62% of variance (Sabater-Pastor et al. 2023) —
far weaker than the ~85%+ VO2max typically explains at marathon distance. An
ultra-runner's Strava history is mostly easy aerobic miles plus a handful of
multi-hour races — neither constrains VO2max well. **The fix isn't more
volume, it's coverage**: flag to the athlete that a 5k-30min hard effort
(race or time trial) is worth more for VO2max than another year of easy
mileage, and don't report a confident VO2max fit without at least one such
effort in the library.

Sources: [Simpson & Kordi 2017](https://www.researchgate.net/publication/311450049_Comparison_of_Critical_Power_and_W'_Derived_from_Two_or_Three_Maximal_Tests), [duration-choice sensitivity](https://pubmed.ncbi.nlm.nih.gov/9923729/), [Coquart et al. 2023, 100km](https://pmc.ncbi.nlm.nih.gov/articles/PMC9980800/), [Sabater-Pastor et al. 2023, 166km](https://pubmed.ncbi.nlm.nih.gov/36754060/)

### Q2: Does the fitting approach need to change?

Yes, in two ways — one straightforward, one genuinely open research territory.

**Straightforward: stratify by duration/intensity band instead of pooling
everything into one fit.** Short, hard efforts should drive VO2max/LT2/f0;
long, steady efforts should drive fInf/tau/durability. This is the same
lesson as §11's f0/fInf non-identifiability, just applied per-parameter
instead of per-race-duration.

**Open territory: intensity — not raw duration — looks like the real axis
for how fade sharpens, and no published model does this split.** The
hypothesis that races fade differently at different durations is directionally
right, but the mechanism isn't "long vs. short," it's *relative effort and
mechanical load*. The cleanest evidence: Saugy et al. (2013) found the 330km
Tor des Géants produced *less* neuromuscular damage than Millet et al.'s
(2011) 166km UTMB study — half the distance, more damage — attributed to more
conservative pacing over the longer race. Millet's UTMB data itself shows the
signature the current model is missing: central (neural) fatigue resolved
within 2 days, but peripheral (muscular/contractile) fatigue took ~9 days —
two mechanisms with different time courses, not one decay curve. A marathon,
by contrast, shows a central-dominant, peripheral-*sparing* pattern (no
low-frequency fatigue detected) — consistent with "shorter/harder = more
VO2max/central, longer/muscular = more peripheral," but driven by intensity
and eccentric load (descent), not elapsed time per se. No published paper
fits a two-component (central+peripheral) model, or an intensity-dependent
tau, at ultra timescales — this would be novel work, grounded in real
findings but without a formula to copy. **Recommendation: don't jump straight
to a redesigned curve.** First build a cheap diagnostic — plot each stored
race's own single-race tau (already computed by `fitTauMinutes`) against that
race's average relative intensity (`avgEffortFraction`, already computed by
`analyzeRun`) and its total descent. If a real relationship shows up in the
athlete's *own* data, that justifies the harder work of building an
intensity- or descent-dependent fade term next.

Sources: [Saugy et al. 2013, Tor des Géants](https://pmc.ncbi.nlm.nih.gov/articles/PMC3694082/), [Millet et al. 2011, UTMB](https://pmc.ncbi.nlm.nih.gov/articles/PMC3043077/), [Temesi et al. 2014, TMS central fatigue](https://pubmed.ncbi.nlm.nih.gov/24195865/), [Tiller & Millet 2025, muscle damage as primary ultra limiter](https://pubmed.ncbi.nlm.nih.gov/39405022/), [Drake, Finke & Ferguson 2023, power-law vs. critical-power](https://pubmed.ncbi.nlm.nih.gov/37563307/), [Maunder et al. 2021, "durability" as a 4th pillar](https://link.springer.com/article/10.1007/s40279-021-01459-0)

### Q3: Adapting over time, and weighting inputs by source

**Avoid a Banister-style fitness/fatigue convolution (CTL/ATL/TSB) — it's a
training-load score, not a physiological measurement, and it doesn't hold up
well even in its home domain.** TrainingPeaks' own documentation says CTL/ATL
are "relative indicators, not absolute predictors" that were never linked to
specific physiological events. A 2025 Bayesian re-analysis (Marchal et al.,
*Scientific Reports*) found the model's time constants are largely
non-identifiable and that adding the fatigue term didn't improve
cross-validated predictive accuracy — a textbook overfitting signature. Not a
foundation to build VO2max-tracking on.

**What real tools actually do instead is much simpler: rolling or decaying
windows, not sophisticated filtering.** Golden Cheetah refits its critical-power
model from the last 6 weeks; WKO5 uses a 90-day equal-weight window; Stryd
uses a 90-day window where the most recent ~30 days count fully and weight
decays toward zero after that. No peer-reviewed paper applies Kalman
filtering or Bayesian state-space tracking to VO2max/CP specifically — the
closest precedent is a within-session (not longitudinal) drift model.
**Recommendation: extend the existing weighted-least-squares fits
(`pacingFit.ts`) with a time-decay factor** —
`weight *= exp(-ln(2) * daysAgo / halfLifeDays)` multiplied onto the existing
`dtS` weight — rather than building a new estimation framework. A halfLife on
the order of 60-90 days matches what Stryd/WKO5 use in practice, and is
consistent with VO2max test-retest noise (CV 1-4%) being small relative to
multi-week training gains (4-10%+) — short enough to track real adaptation,
long enough not to chase noise.

**Dated, sourced manual inputs should be treated as anchor points with a
confidence weight, combined via inverse-variance weighting** — the standard
statistical tool for combining measurements of known differing reliability
(the same method used in meta-analysis and NIST metrology). Concretely,
`vo2MaxMlPerKgPerMin` (and eventually `fatOxPoints`) becomes a dated,
sourced history list rather than one scalar, and a resolver function
combines entries near "now" (recency-weighted) with the athlete's own
Strava-derived trend, each inverse-variance-weighted by source:
- **Lab test** (gas analysis): treat as near-ground-truth, tightest weight.
- **Race-derived (VDOT-style, from an actual maximal 5k-marathon effort)**:
  SEE ≈ 2-5 ml/kg/min in validation studies.
- **Wearable, moderate fitness**: MAPE ≈ 3-4% (Garmin Forerunner 245 study).
- **Wearable, well-trained athlete**: notably *worse*, not better — the same
  study found MAPE ≈ 9-10% (underestimating by ~6 ml/kg/min) in
  highly-trained runners specifically, the opposite of what "better data
  from fitter athletes" would suggest. This matters directly for an
  ultra-runner's own Garmin number.
- **Manual guess**: wide uncertainty, lowest weight.

No existing platform (Garmin Connect, TrainingPeaks, Stryd) documents doing
this kind of multi-source fusion for VO2max — it'd be a genuine differentiator,
not a known pattern to copy, but the underlying statistics (inverse-variance
weighting) are standard and low-risk to implement.

Sources: [TrainingPeaks, Performance Manager](https://www.trainingpeaks.com/learn/articles/the-science-of-the-performance-manager/), [Marchal et al. 2025, Banister model non-identifiability](https://www.nature.com/articles/s41598-025-88153-7), [Stryd critical power decay](https://blog.stryd.com/2019/08/22/auto-calculated-critical-power-depreciation/), [WKO5 Power-Duration Model](https://www.wko5.com/wko-power-duration-model-v2), [Molina-Garcia et al. 2022, INTERLIVE wearable VO2max meta-analysis](https://link.springer.com/article/10.1007/s40279-021-01639-y), [Forerunner 245 fitness-dependent accuracy, 2025](https://pubmed.ncbi.nlm.nih.gov/40770433/), [Polar OwnIndex ~30% overestimate in masters athletes](https://www.mdpi.com/2411-5142/10/4/431), [NIST inverse-variance combination of measurements](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4551221/)

### Proposed staged architecture

1. **Bulk Strava backfill — built.** Pages through `/athlete/activities`
   (already supports `page`/`before`) storing lightweight summaries
   (distance, duration, elevation, avg HR/power) for a whole date range in
   ~15-25 requests, not 300-600 — full GPS points are only fetched lazily,
   once a run is actually selected. `suggestRunsForFit` ranks summary-only
   runs by likely usefulness: the VO2max bucket is restricted to the
   20-90min window `vo2MaxEstimate.ts` can actually use (see stage 3 below),
   and the durability bucket requires at least an hour (shorter runs can't
   meaningfully move an ultra-scale tau — see the fit's own "unresponsive"
   flag) and diversifies by descent-per-km proxy instead of just picking the
   longest few, since descent variety is what stage 4's diagnostic needs
   (that same bucket feeds both — there's no separate stage-5 bucket, since
   an advisor review flagged that spreading picks across duration/intensity
   wouldn't actually *decorrelate* them: this athlete's real training data
   sits on a diagonal, short-and-hard vs. long-and-moderate, so maximizing
   spread on a mixed-unit intensity axis would just re-pick the diagonal's
   extremes, not break the confound — the honest, buildable win is more
   races and descent variety, not manufactured decorrelation). A third
   `durationSpread` bucket preps for §11's still-unbuilt joint (f0, fInf,
   tau) fit: the single longest race plus others at least ~2x shorter, kept
   duration-only and unmixed with intensity for the same reason. A handful
   of genuinely useful runs can be approved and fetched without scanning
   hundreds of rows or risking Strava's rate limit. See
   `src/model/stravaBackfill.ts`, `src/model/suggestRuns.ts`,
   `RunLibraryPanel.tsx`.

   **Bug found and fixed (2026-07-22): the durability bar above only
   gated which summary-only runs were worth fetching, not which
   already-fetched runs actually fed the pooled fits.** Once a run had
   full GPS points -- whether fetched via a suggestion, backfilled
   directly, or uploaded manually -- it unconditionally joined every
   pooled fit (tau, fInf, the terrain multiplier, the HR calibration), no
   matter how short. Reported by the user: with 24 stored runs (mostly
   short daily training runs alongside a handful of genuine long races),
   the joint fit landed on an implausible fInf 0.74/tau 85min, and the
   terrain-multiplier backtest showed wildly inconsistent per-run errors
   (several runs' fitted-multiplier error *worse* than baseline by 20-30
   points). The existing "unresponsive" flag catches this only after the
   fact, as a diagnostic -- it doesn't stop short, noisy runs from
   distorting the search itself; enough near-flat short runs pooled
   alongside a few long races can pull tau toward a spuriously small
   value that trivially "fits" the short runs' near-zero slope without
   reflecting real fatigue-decay behavior. Fixed by exporting
   `DURABILITY_MIN_DURATION_S` from `suggestRuns.ts` and applying the
   same 1-hour bar inside `RunLibraryPanel.tsx`'s `runFit()`, filtering
   the shared per-run loop that feeds every pooled fit -- not just the
   fetch-suggestion step. Verified on a real mixed pool (4 real long
   races + 15 real 30-60min training runs): before the fix this is
   exactly the scenario that produced spurious results; after, "Left out
   15 runs under 60 minutes" is reported and the joint fit lands back on
   fInf 0.68/tau 297min, matching the same 4-race-only result validated
   earlier in stage 6 and PLAN.md §11. A new UI note reports how many
   runs were excluded this way, mirroring the existing transit-gap note.
2. **Time-decay weighting in the tau fit — built.** `fitTauAcrossRaces` takes
   an optional `{raceDates, halfLifeDays, now}`; each race's contribution to
   the pooled objective decays by `exp(-ln2*daysAgo/halfLifeDays)`, default
   75 days, adjustable in the UI. Only the multi-race fit needed this — a
   single race has no other race to be "more recent than." See
   `src/model/pacingFit.ts`.
3. **Dated, sourced VO2max history — built**, including auto-derived
   estimates from a recent hard effort. `FormInputs.vo2MaxHistory` replaces
   the old scalar; `resolveVo2Max` combines entries via inverse-variance (by
   source confidence) × recency (180-day half-life — VO2max moves over a
   training macrocycle, not day to day) into the single number
   `ceilingParams` needs. `loadFormInputs` migrates an existing pre-history
   save into one manual entry. See `src/ui/formInputs.ts`,
   `src/ui/InputsPanel.tsx`.

   `src/model/vo2MaxEstimate.ts` derives a candidate estimate from a single
   already-fetched run by inverting the app's own ceiling curve, rather than
   an external formula (e.g. Daniels-Gilbert) never validated against this
   app's Minetti-based cost model: `ceilingPower` is exactly linear in
   `vo2MaxMlPerKgPerMin`, so `avgEffortFraction` (from `analyzeRun`, computed
   against whatever vo2max is currently assumed) times that assumed vo2max
   recovers the true one — invariant to what was assumed, as long as the run
   was genuinely paced near-maximally for its own duration. Restricted to a
   20-90 minute window (below it the model's duration curve is flat at the
   LT2 cap; above it a run is endurance-paced, not near-maximal — shared with
   `suggestRunsForFit`'s VO2max bucket, which was previously an inconsistent
   120-minute cutoff despite its own comment citing 2-15min trials).
   Surfaced in `RunLibraryPanel` as a reviewable suggestion (adds a
   "race"-sourced history entry), never auto-applied — GPS data alone can't
   confirm a run was actually run near-maximally, only that its duration
   makes the assumption defensible.
4. **Diagnostic: does descent load actually predict this athlete's own
   tau? — built.** Reuses `fitTauMinutes` and `avgEffortFraction`;
   `totalElevationLoss` added to the pipeline (mirroring the existing
   `totalElevationGain` sum — descent wasn't tracked anywhere before this).
   `RunLibraryPanel` tabulates per-race tau vs. descent-per-km vs. intensity
   across already-fetched runs, with a Pearson correlation for each — the
   hypothesis specifically predicts a *negative* one (harder/more
   descent-loaded runs fading faster), not just any relationship. See
   `src/model/tauDiagnostic.ts`.

   Also added: `src/model/descentImpact.ts`, testing a sharper version of
   the descent hypothesis — that it's descent *covered fast* (eccentric
   loading/impact forces), not descent alone, that drives fade. Computed
   per-segment as descent-meters × that segment's own speed, summed and
   normalized per km (not total-descent × whole-race average pace, which
   would blend a fast downhill stretch and a slow flat stretch into one
   meaningless number). Kept alongside — not replacing — raw
   `descentPerKm`, so the two can be compared rather than assuming the
   sharper metric is automatically better. Important caveat surfaced in the
   UI: speed is baked directly into this metric, so it's confounded with
   `avgIntensity` the same way a fast race is both "intense" and "high
   impact" — the meaningful comparison is against intensity, not against
   raw descent (impact will tend to beat raw descent for reasons that have
   nothing to do with descent at all, purely from the speed term).

   **Speed²-weighted variant also built** (`descentImpactSquared` in the
   same file): kinetic-energy-proportional rather than linear-in-speed —
   impact/eccentric loading forces are often modeled as scaling with
   kinetic energy, at least as defensible as the linear version. Offered
   as a second, independent reading rather than a replacement (there's no
   established result saying which scaling is correct here); the diagnostic
   reports both variants' correlations side by side, plus a note that
   comparing the two against *each other* tells you whether the exponent
   matters at all — if they're about equally (un)correlated with tau, the
   library doesn't yet distinguish linear from quadratic.

   Other variants considered but not built, worth a follow-up if neither
   speed-weighted form shows a clean signal: **steep-grade-only
   thresholding** (only count descent below some grade, e.g. -8-10%, on the
   theory that gentle downhill roads don't load eccentrically the way
   steep technical trail does); and, if this ever feeds an actual
   durability *model* rather than just this diagnostic, a **cumulative**
   (running-total-so-far) form rather than a single race-level summary —
   the same way `durabilityDriftPerHour` would need to key off cumulative
   descent-impact-so-far, not a whole-race total, at each point in a race.

   **Confound found and fixed in `avgIntensity` itself.**
   `avgEffortFraction` is actual power ÷ the model's own duration-decaying
   predicted ceiling, computed against whatever `tauMin` the caller
   assumed — using one global default tau for races of very different
   lengths systematically inflated the reading for anything much longer
   than that tau's own timescale (a ~30h race read as 94% effort against a
   250min default tau, since the assumed curve had already decayed to
   near-fInf long before the race was done). Fixed by
   `raceDiagnosticPoint.ts`'s `buildRaceDiagnosticPoint`: fit each race's
   own tau first (already reported by the diagnostic), then recompute
   `avgEffortFraction` against THAT tau, not the global default. Verified
   on real data: Soria Moria 94%→55%, Ecotrail 80 101%→78%; the
   tau-vs-intensity correlation across all races went from an unstable,
   confounded reading to a consistent -0.60 at n=12.

   **Within-race redesign, not just a whole-race diagnostic — built.** The
   whole-race diagnostic above averages descent-load and fade over an
   entire race, which can't distinguish "this race was generally hard"
   from "a fast descent specifically degraded output afterward" — the
   actual physiological claim under test. `withinRaceDescentDiagnostic.ts`
   splits each race in half by elapsed time, computes early-window descent
   metrics (normalized per km) and the late window's own residual fade
   trend relative to the race's already-fitted whole-race tau (not a
   second independent fit). Validated with synthetic known-injected-effect
   and null-control tests (catching and fixing 3 real bugs in the
   synthetic course builder along the way: distance3D/horizontal
   derivation order, a bogus altitude-adjustment penalty from synthetic
   elevation, and an overly-strict null-control assertion) before trusting
   it on real data. Real data initially showed an unstable, wrong-signed
   correlation (+0.32 to +0.37) driven by two ~20-minute "races" whose late
   windows were too short to carry any real fatigue signal but dominated
   the small sample — fixed per the athlete's own hypothesis ("I doubt we
   will see any muscular fade in runs below 1 hour") by adding a
   `minLateWindowHours` floor (default 1h) alongside the existing
   point-count floor. Re-run: n dropped from 12 to 7, correlations flipped
   to the hypothesized direction (raw descent -0.58, descent impact -0.39,
   descent impact² -0.23) — the "real signal" gate stage 5 below was
   waiting on.

   **Follow-up: "running impact" metric built; checked for the same fade
   signal — a moderate negative correlation, but not descent-specific and
   not enough independent data to trust yet.** Separately from the
   descent-eccentric-loading work above, reverse-engineered an
   athlete-facing "running impact" score from an external source (ad hoc
   session: least-squares fit against 9 known (distance, elevation, score)
   tuples, validated out-of-sample on three independent held-out sets — a
   training week never seen while fitting, plus two point-to-point long
   runs/ultras with genuine ascent≠descent asymmetry, the only real
   leverage available to test whether descent should be weighted more
   heavily than ascent). The winning, best-generalizing model was the
   simplest one tried: distance plus a Minetti grade-cost "hill surcharge",
   2 parameters. Every 3-parameter variant that added an explicit descent
   term fit the two point-to-point runs almost perfectly but generalized
   *worse* on the May holdout — overfitting to two high-leverage points,
   not a real finding. Built as `src/model/runningImpact.ts`
   (`DEFAULT_RUNNING_IMPACT_COEFFICIENTS`: distance 6.9098/km, hill
   surcharge 10.6943/km).

   Wired into `withinRaceDescentDiagnostic.ts` as a fourth early-window
   predictor (`earlyRunningImpactPerKm`), reusing its existing early/late
   split rather than a fresh regression — the same time-confound control
   the descent metrics already get. Per-km normalization divides the
   distance term down to a constant, so — a first assumption caught and
   corrected before it shipped — this predictor isn't a time/distance proxy
   at all; it's driven entirely by early-window grade cost, a pure
   terrain-difficulty signal. What it *doesn't* isolate is descent
   specifically: it lumps ascent+flat+descent into one number, and its
   hill-surcharge term comes from Minetti *metabolic* cost, where
   gentle-to-moderate descent is cheaper than flat — so within the range
   most real descents fall in, steeper descent scores *lower* on this
   metric even as a genuine eccentric-damage effect would make the
   late-window residual more negative. A real muscular-fade effect
   specifically from descent would therefore show up as a *positive*
   correlation here, opposite the descent metrics' predicted sign — locked
   in via a synthetic test using gradients that stay inside the monotonic
   region of the cost curve (it stops being monotonic past roughly -20%,
   where the curve bottoms out).

   Run against real data via `scripts/testRealStravaFit.ts` across three
   overlapping real race samples (`suggestRunsForFit` reselects its
   candidate pool per date range, so these aren't nested subsets of each
   other): +0.58 (n=6), -0.76 (n=7), -0.89 (n=8). The apparent sign flip
   didn't survive a second look — the n=6 reading is a single-point
   artifact: one race's late window read +66.6%/h (wildly outside every
   other race's range, next-most-extreme is -26.5 — almost certainly a
   pacing/GPS artifact the 1h-window floor doesn't screen for), and it
   alone accounts for essentially the entire positive covariance sum;
   dropping it turns the same n=6 sample negative (-0.78), in line with the
   other two. So the honest read is: a moderate, consistently-signed
   negative correlation (~-0.8) across the samples once that one outlier is
   set aside — but since this correlation is (by the algebra above) really
   a terrain-difficulty signal rather than a descent-specific one, a
   negative reading is exactly as consistent with "hilly early miles
   predict a generically harder race" as with a genuine descent-driven
   eccentric effect, and it can't distinguish the two. Combined with only
   6-8 races, overlapping (non-independent) samples across the three runs,
   and 4 metrics tested at once (undocumented multiple-comparisons
   exposure), this doesn't clear the bar the descent metrics needed before
   feeding stage 5's durability term. No durability-term change follows;
   logged as a real but not-yet-actionable lead, worth another look once
   more within-race-diagnostic-eligible races accumulate.

   **Re-checked with more data (2026-07-22): the signal got weaker, not
   stronger.** The run library has grown substantially since the reads
   above (n=16 runs/legs now qualify for the within-race diagnostic, up
   from 6-8). Re-running the same diagnostic against all of it: raw
   descent -0.21, descent impact -0.21, descent impact² -0.22 (down from
   -0.58/-0.39/-0.23 at n=7), and running impact +0.19 (vs. the earlier
   ~-0.8 read across three small overlapping samples, one of them driven
   by a single-point outlier). None of these clear the ~-0.5 bar this
   project treats as "worth building" elsewhere. The direction of travel
   is the more informative part: a real, robust effect should firm up
   with more independent data, not fade toward zero — this pattern (strong
   in a small, overlapping sample; weak once the sample roughly doubles)
   is the signature of small-sample noise, not a signal getting clearer.
   Read together with the caveats already logged above (few races,
   overlapping samples, multiple comparisons, a metric that can't actually
   distinguish "generically hilly" from "descent-specific"), the honest
   conclusion is now firmer: this lead does not clear the bar for a model
   change, and more data alone doesn't seem to be the missing ingredient —
   a differently-designed diagnostic (or the steep-grade-only/cumulative
   variants floated above, still unbuilt) would be needed to actually
   settle it, not just a bigger sample of the same one.
5. **Descent/eccentric-load-dependent durability term — built**, once the
   within-race diagnostic above cleared its own "real signal" gate (n=7,
   all three descent-exposure forms negatively correlated with late-race
   fade in the hypothesized direction). Added as a second, independent
   multiplicative drift term in `ceiling.ts`
   (`durabilityDriftPerDescentUnit` / `CeilingInput.descentExposure`),
   composing with — not replacing — the existing time-based
   `durabilityDriftPerHour`. All three descent-exposure forms from stage 4
   (raw descent, descent×speed, descent×speed²) are kept as live
   candidates rather than picking one; `ceiling.ts` itself is agnostic
   about which metric `descentExposure` represents — that choice belongs
   to the caller.

   `descentImpact.ts`'s per-segment core was extracted into
   `descentStepForSegment` so the whole-array summaries, `pacingFit.ts`'s
   incremental per-point tracking, and `solver.ts`'s incremental
   prediction-time tracking share one elevation-delta/pause-exclusion
   implementation instead of three. `pacingFit.ts` gained cumulative
   descent fields on `EffortTrendPoint`, a single-race fit
   (`fitDurabilityDriftPerDescentUnit`), and a pooled multi-race fit
   (`fitDurabilityDriftPerDescentUnitAcrossRaces`, mirroring
   `fitTauAcrossRaces`'s per-race-squared-slope pooling — needed once a fit
   has to span a training set of races, not just recover a rate from one).
   `solver.ts`'s `SolverInputs` gained `descentExposureBasis`, tracked via
   the segment's own *simulated* speed during forward simulation,
   deliberately NOT via `descentStepForSegment`'s recorded-pace speed — a
   planning-mode course typically has no timestamps at all, and even a
   previously-recorded GPX's pace isn't what the solver is predicting.

   Every new fitting mechanism was verified with a synthetic
   known-injected-rate recovery test before being trusted, same discipline
   as stages 1-4. One real trap surfaced during that verification:
   `solver.test.ts`'s first synthetic descent course reused a fixture that
   pinned `elevation` at 0 regardless of gradient (fine for the grade-cost
   tests it was built for), which made the descent term's own test
   exercise ~1% of the intended exposure and pass for the wrong reason —
   fixed by building a course whose elevation genuinely accumulates, and by
   choosing an effort level with enough headroom above the walk-speed cap
   that the effect shows up as a graduated pace change, not a discrete
   run/walk mode flip that's identical regardless of the rate's magnitude.

   **Out-of-sample backtest tooling — built and run.**
   `scripts/backtestFinishTime.ts` fits (fInf, tau) and a per-basis descent
   drift rate on a training window of past races, excluding one named
   target race, then predicts that race's finish time via the real solver
   (`findSustainableTheta`) and compares it to what actually happened —
   reporting all 4 candidates (baseline + 3 descent bases) against the
   actual recorded moving time. This is the first genuinely predictive
   check in this project (everything above validates retrospective fit,
   not prediction of a held-out race) and is meant to be the actual
   arbiter of whether any descent form earns a permanent place in the
   model. **Important interpretive caveat:** within one race, cumulative
   descent exposure is close to monotonic in elapsed time, so a good
   in-sample fit (`fitDurabilityDriftPerDescentUnitAcrossRaces` flattening
   the training races) is close to guaranteed by construction and easily
   confounded with tau/time-drift already explaining the same trend — it
   is NOT evidence the term matters. Only the backtest script's held-out
   comparison is.

   **General mechanism added mid-investigation:
   `informativeRaceCount`.** The first Soria Moria run below fit an
   implausible tauMin (34.6h, longer than the race itself). Investigating
   why surfaced a general failure mode, not a Soria-Moria-specific one: a
   pooled fit's "unresponsive" races (already tracked) contribute
   approximately nothing to the pooled objective, so if only ONE race in
   the training set is actually responsive, the "pooled across N races"
   result is really just that one race's own idiosyncratic pacing wearing
   a multi-race label. `fitTauAcrossRaces`, `fitFInfAndTauAcrossRaces`, and
   `fitDurabilityDriftPerDescentUnitAcrossRaces` now all report
   `informativeRaceCount` alongside their per-race `unresponsive` flags;
   `MIN_INFORMATIVE_RACES` (2) gates trust in `backtestFinishTime.ts`'s
   three-tier fallback (joint fit → tau-only fit → hold current defaults,
   each tier requiring enough informative races) and in a new
   `RunLibraryPanel.tsx` warning, mirroring the existing
   `durationDiversityRatio` treatment. Not a backyard-ultra-specific fix —
   it generalizes to any training set where only one race (for any reason)
   actually constrains the parameter.

   **Real results, both named cases, re-run with the gate (2026-07-19):**

   *Soria Moria til Verdens Ende* (target: 2026-05-30, 171km/~24.5h;
   27 candidate races from 2025-01-01 to 2026-05-30): the joint fInf/tau
   fit's own tau-only fallback reported **informativeRaceCount=1/27** — the
   previous 34.6h tauMin (and, after excluding the 106.9km backyard ultra
   with `--exclude="Backyard"`, the revised-but-still-implausible 19.7h)
   were both driven by a single race, confirmed by re-running with and
   without the exclusion: identical informativeRaceCount=1/27 either way,
   so the backyard ultra was never the actual cause. With the gate
   correctly refusing both and holding tau=250min/fInf=0.38 (the
   configured defaults) instead, the baseline prediction improved
   dramatically: **-9.2% error** (22h17m33s vs. the actual 24h33m16s) —
   far closer than either "fitted" version's -26.8%/-24.7%. All three
   descent-drift bases were also correctly skipped (0/27 informative each).
   This is real evidence the mechanism works: refusing an unsupported fit
   and falling back to sane defaults out-predicted trusting the fit, not
   just "looked safer" in the abstract. What's left unresolved: this
   athlete's real training data (as backfilled so far) simply doesn't
   contain more than one race anywhere near ultra-length, so tau/fInf
   aren't genuinely identifiable for this distance scale yet, and the
   descent term has no signal to learn from either — more long training
   races, not a smarter fit, is what Soria Moria actually needs next.

   *Ecotrail 80* (target: 2025-05-24, 80km; 25 candidate races from
   2024-01-01 to 2025-05-24): the joint fit here IS well-supported —
   informativeRaceCount=15/25, durationDiversityRatio=9.6, fInf=0.529,
   tauMin=169min — a genuine pooled result, unlike Soria Moria's. Baseline
   underpredicted the actual 8h24m50s finish by -5.0% (7h59m37s).
   `descentMeters` (informativeRaceCount=4/25) improved on it substantially
   — 8h23m58s, essentially exact at -0.2% error. `descentImpact` and
   `descentImpactSquared`, previously reported as -2.1%/-3.5% improvements,
   turned out to be supported by only 1/25 and 0/25 informative races
   respectively once checked — the gate now correctly skips both rather
   than reporting numbers from what amounts to zero or one race's descent
   pattern. So the real, trustworthy result here is narrower than first
   reported: **one supportive out-of-sample data point, `descentMeters`
   only.**

   Net, honestly: one real, well-supported out-of-sample result favoring
   the descent term (Ecotrail 80, `descentMeters` basis, -0.2% vs. -5.0%
   baseline), and one race (Soria Moria) where neither tau/fInf nor any
   descent basis could be tested at all due to insufficient long training
   data — not a null result on descent-based durability, an absence of a
   result. Not enough to declare any basis "the" answer yet — more
   held-out cases, and especially more *long* training races for the
   athlete's ultra distances, are the natural next steps.

   **Second interpretive caveat, specific to the two speed-weighted
   bases:** `descentImpact`/`descentImpactSquared` are fit (in
   `pacingFit.ts`, via `descentStepForSegment`) against each training
   race's *actual recorded* descending speed, but predicted (in
   `solver.ts`'s `simulate`) against the solver's own *simulated* pace for
   the target race — those two speeds aren't the same thing, so a rate
   fit under one doesn't necessarily transfer cleanly to the other.
   `descentMeters` has no speed term and isn't affected by this — it's the
   clean primary basis to trust at face value; read `descentImpact`/`²`
   backtest results with this mismatch in mind, not as directly comparable
   to `descentMeters`'s. The principled fix (re-deriving exposure from the
   solver's own simulated speeds on the training races, not their recorded
   ones) is real work and only worth doing if the backtest shows a
   speed-weighted basis outperforming `descentMeters` despite the handicap
   — not worth building speculatively before that signal exists.

6. **Terrain surface cost — built, then substantially revised.**
   Investigated whether unpaved/technical terrain (not just gradient)
   predicts additional slowdown beyond what the Minetti cost curve already
   captures.

   **Surface classification — built.** `src/model/surfaceExposure.ts`'s
   `attachSurfaceData` classifies each course segment as paved/unpaved via
   a public OpenStreetMap map-matching lookup (Valhalla's
   `trace_attributes`, see `src/ui/surfaceLookup.ts`/`api/surface.ts`),
   fetched once per run and cached (`StoredRun.surfaceEdges`). Maps
   Valhalla's sequential edges (surface + length, in route order) onto
   this app's own resampled segments by cumulative-distance fraction,
   scaling for the two pipelines' slightly different total distances.
   Fails silently (leaves a run's segments with `surfaceUnpaved:
   undefined`, distinct from `false`) rather than surfacing an error —
   callers already have to handle "no data" for a fresh course anyway.

   **First mechanism: cumulative durability drift — built, then
   reverted.** Modeled surface the same way as stage 5's descent term: a
   fraction-of-ceiling-lost per unpaved meter covered so far, composing
   with the existing `durabilityDriftPerHour`/`durabilityDriftPerDescentUnit`
   terms in `ceiling.ts`. A leave-one-out backtest across real races
   (holding tau/fInf fixed per fold) showed this fit far worse than a
   flat, instantaneous alternative (~25% mean error vs ~9%, see below) —
   technical terrain appears to cost more to move across right there, not
   to accumulate fatigue that lingers once back on pavement. Fully
   reverted rather than left as dead/disabled code: `CeilingInput`'s
   exposure field, the ceiling composition term, and the cumulative-
   exposure tracking in `pacingFit.ts`/`solver.ts` were all removed.

   **Second mechanism: flat cost multiplier — built and shipped.**
   `unpavedCostMultiplier` in `solver.ts`/`analysis.ts` multiplies
   `costOfRunning`/`costOfWalking` on segments classified unpaved, with
   zero carryover to subsequent paved segments — an instantaneous, not
   cumulative, penalty. A third alternative, a hard speed cap on unpaved
   terrain (mirroring `maxDescentSpeedMs`, motivated by the effort-
   fraction finding below), was also built and compared honestly; it fit
   worse (~13% vs ~9%) and was removed — a cost multiplier apparently
   captures the gradient-dependence of technical terrain (steep+technical
   costs more than flat+technical) that a flat speed cap can't.

   **Fitting method: effort-fraction gap — built, then found flawed.**
   The first production fit (`fitUnpavedCostMultiplierAcrossRaces`)
   searched for the multiplier that equalized recorded effort fraction
   between unpaved and paved segments, mirroring stage 5's "pool per-race
   squared slope" pattern. A real-data check found this athlete's own
   recorded effort fraction is actually flat or slightly *negative* on
   unpaved terrain — they aren't producing more power there, if anything
   less; they simply move slower, likely a technical-terrain speed
   constraint (footing, navigation) rather than a metabolic one. This
   meant the objective structurally could not recover anywhere near the
   multiplier a direct finish-time backtest showed the mechanism actually
   needs (~1.1x vs ~1.5x): it was searching for a signal (elevated
   effort) that doesn't exist in this data, even though the underlying
   cost-multiplier mechanism itself is sound.

   **Rewritten to fit directly against finish time — built and
   validated.** `fitUnpavedCostMultiplierAcrossRaces` now takes each
   training race's full segments plus actual recorded finish time (not
   just lightweight trend points) and searches for the multiplier that
   best predicts finish time via the real solver (`findSustainableTheta`),
   holding tau/fInf fixed — the same "one axis at a time" approach as
   every other fit in this file, but the first one here needing a real
   forward-simulation per candidate rather than free arithmetic over
   precomputed points. Meaningfully more expensive (a "Fit" click now runs
   dozens of real solver simulations); kept tractable with a coarser
   search grid and reduced solver precision during the search only
   (`FIT_SEARCH_SOLVER_OPTIONS`), never for the real predictions the
   fitted multiplier later drives.

   **Leave-one-out backtest, real data (2026-07-22):** across 7 long real
   races (≥40km), holding tau/fInf fixed per fold and fitting the
   multiplier from only each fold's own training races: baseline (no
   terrain effect) 25.4% mean error → **8.1%** with the fitted cost
   multiplier (shipped production code, not a scratch reimplementation).
   Fitted multipliers were tightly clustered (1.5-1.7x — this athlete
   moves roughly 50-70% slower per unit metabolic cost on unpaved
   terrain) across all folds, not noise. For comparison, the disproven
   alternatives backtested at: cumulative drift ~25% (no better than
   baseline), speed cap ~13%, effort-fraction-gap-fit multiplier ~25%
   (same fit-method problem as above — the fitted multiplier collapsed
   toward ~1.1x, near-zero net effect).

   **A second, unrelated data-quality issue found and fixed along the
   way: transit gaps.** One of the original marquee "long race" backtest
   targets (`Morning Run`, 2025-10-19, nominally 55.9km/3.35h) turned out
   to include two GPS gaps at ~40-50km/h with zero recorded running power
   — a train ride embedded in the middle of a real run, not a mislabeled
   activity as first suspected. Contaminated every backtest run before it
   was found (baseline error alone dropped from 27.9% to 25.4% once
   excluded). `src/gpx/transitGap.ts`'s `splitAtTransitGaps` now detects
   this automatically (a raw, pre-resample point-to-point step implying
   >7 m/s over >300m — has to run on raw points, since the pipeline's
   fixed-distance resample linearly interpolates straight across a gap
   like this, smearing one huge jump into many innocuous-looking segments
   rather than one obvious spike) and splits the run into its genuine
   contiguous legs, wired into `RunLibraryPanel.tsx`'s training-data build
   and diagnostics — the real running on either side of a transit gap is
   still used, just as separate legs, instead of discarding the whole
   recording.

   **Follow-up: does the full surface-type granularity help? Checked
   twice, negative both times.** The user asked whether using Valhalla's
   full surface vocabulary (gravel/dirt/compacted/path), not just binary
   paved/unpaved, would improve on the single flat multiplier. First
   check: pooled effort fraction by surface type across 145 runs (not
   just the 7-8 marquee races) -- a real, orderly pattern held up with far
   more data than before: paved 88.3% > dirt 81.6% > gravel 76.9% ≈
   compacted 75.1% > path 66.2%, with path showing the largest gap (-22pp
   from paved) across 73 diverse runs. That motivated retesting the
   2-group finish-time backtest (see stage 6 above) along a path-vs-rest
   split instead of the earlier failed gravel-vs-rest one. Result: 25.4%
   baseline → 10.1% -- better than gravel-vs-rest's 13.5%, but still worse
   than the single multiplier's 8.1%, and path's own multiplier landed
   exactly at its search boundary (1.00x, no effect) in every fold, with
   all the cost pushed into the other category. Real, informative, and
   negative: this athlete's raw effort genuinely varies by surface type
   (confirmed with much more data than the first pass), but that finer
   behavioral signal doesn't translate into a better finish-time-
   prediction mechanism for this solver-based approach -- the extra
   parameter doesn't earn its keep for that specific objective. Binary
   paved/unpaved remains the shipped granularity.

   **Third attempt: derive the path multiplier from real device power
   instead of the solver's own effort fraction. Bug found in the second
   attempt's scratch harness; still negative once fixed.** The user
   pushed further: instead of comparing whole-run/whole-race averages
   (confounded by each run's own pacing intensity, and circular if
   "power" is derived from the model's own Minetti cost curve — at fixed
   gradient, model-power *is* speed, so bucketing by it and looking at
   speed can't show a surface effect by construction), bucket small
   segments by *real device power* (Stryd, recorded independently of any
   cost model — 109 cached runs have both) and gradient, then compare
   achieved speed across surface types within each cell. Result: a real,
   consistent, non-circular signal -- "path" is 9-31% slower than paved at
   the same real power and same gradient, holding across all 20
   independent (gradient × power) cells tested (dozens of runs and
   hundreds-to-thousands of segments per cell), worsening on steeper
   climbs and at higher effort. Gravel/dirt/compacted showed no consistent
   pattern. Converting the weighted-mean speed ratio to an implied cost
   multiplier (cost_path/cost_paved = v_paved/v_path at fixed power and
   gradient) gave a candidate of **1.164x**.

   Backtesting that fixed candidate against the held-out races surfaced a
   real bug in the second attempt's scratch categorization code: it
   classified each segment by what *fraction of the whole course up to
   that point* was path/other-unpaved (a cumulative running average), not
   by the surface at that specific point. Since path rarely exceeds 50% of
   a course's cumulative distance, "path" was essentially never assigned
   anywhere -- which is exactly why that attempt found path's own
   multiplier parked at its search boundary (1.00x, no effect) with all
   cost pushed into "other": there was effectively no "path" category to
   fit. Fixed with the same point-level lookup already used for the
   effort-fraction pass (binary search on Valhalla edge boundaries, no
   cumulative averaging).

   With that fixed, the real-power-derived 1.164x candidate was backtested
   the same way as every other mechanism here -- LOO across the 7 marquee
   races, tau/fInf refit per fold, all three variants computed in the same
   harness for a fair comparison: baseline (no terrain effect) 25.3% →
   **24.3%** with the fixed 1.164x path-only multiplier, vs. **7.7%** for
   the shipped single flat paved/unpaved multiplier (refit per fold, lands
   around 1.8-1.9x) -- confirming the harness now reproduces the
   previously-documented ~8.1% once both the categorization bug and the
   duration-filter bug (§12 stage 1) are fixed. The real-power signal is
   genuine but far too small: 1.164x barely moves the needle, nowhere
   close to the ~1.8x the finish-time objective actually needs. Most
   likely explanation: the momentary power-vs-speed relationship measured
   on ordinary daily training runs (fresh legs, familiar local trails)
   doesn't capture what a 15-25 hour technical ultra actually costs on
   unpaved terrain -- fatigue, night navigation, and accumulated caution on
   technical footing compound in a way a single power/speed snapshot
   can't see. Real, informative, and negative a third time: binary
   paved/unpaved remains the shipped, best-validated mechanism.

Stages 1-6 are now built. Stages 1-4 (plus the avgIntensity/within-race
fixes folded into stage 4 above) are well-supported by existing literature
and directly extend code that already existed; stage 5 is explicitly
exploratory — its mechanism, fitting, and prediction wiring are built,
unit-tested, and now backtested against two real held-out races (see
above), with one supportive result (Ecotrail 80, `descentMeters`) and one
inconclusive one (Soria Moria, where the surrounding fInf/tau fit itself
looks unreliable). That's early evidence, not a settled result — flag any
of its predictions as exploratory in the UI, the same way the single-race
tau fit already flags negative-split ambiguity, until more held-out cases
back it up. Stage 5's target was sharpened by an independent design
review — see §13. Stage 6 is the most rigorously backtested mechanism in
this project so far (a direct, zero-leakage, held-out finish-time
comparison across 7 real races, not just an in-sample trend fit), and its
final form is genuinely surprising relative to the initial hypothesis: the
data ruled out both the mechanism the project started with (cumulative
drift) and the fitting method built for its replacement (effort-fraction
matching), and only converged on the shipped version after the actual
prediction objective was used to arbitrate between candidates rather than
a proxy.

## 13. Second-opinion design review — comparison against a mechanistic 5-layer model

A separately-written design document (5 layers: terrain demand, aerobic
supply w/ fade, W′/critical-power anaerobic buffer, substrate/glycogen, and
mechanical/muscular fade) was compared line-by-line against what's actually
implemented (`ceiling.ts`, `minetti.ts`, `substrate.ts`, `solver.ts`,
`pacingFit.ts`) and against §12 above. Full comparison for reference; the
one actionable outcome is folded into stage 5 below.

**Confirms, no gap:** gait selection already goes beyond the doc's own
"first cut" (compares achievable speed under both gaits' cost curves rather
than a grade threshold); the descent speed cap (`maxDescentSpeedMs`) already
exists for the same reason the doc cites (Minetti's downhill
predicted/measured speed ratio ~3.4×, eccentric efficiency −1.2 — both
independently confirmed in this session's own research); altitude
correction is an exact formula match; gut-ceiling-on-oxidized-carb (not
intake) is already correct; the tau fit already works at segment
resolution and already regularizes by fixing lab-measured params and
fitting only the latent coefficients — both explicitly recommended in the
doc as if novel, already standard practice here.

**Sharpens something already known to be broken (folded into stage 5):**
PLAN.md/`pacingFit.ts` already documented that `durabilityDriftPerHour`
(linear in elapsed time) is collinear with tau's exponential decay — both
are functions of the same clock, so one race can't separate them. The
design doc reaches the identical diagnosis independently and proposes a
concrete fix: key durability to cumulative supra-threshold + eccentric
work ("E_hard"), not wall-clock time. **Stage 5 is retargeted around this
specifically** — descent load (proportional to cumulative eccentric work)
is the concrete E_hard proxy to test in stage 4's diagnostic, not a vaguer
"intensity" signal.

**Genuinely new, not built or planned elsewhere:**
- **W′/critical-power anaerobic buffer for climbs.** Nothing currently
  represents momentarily exceeding sustainable effort on a steep climb and
  recovering on the descent — `solver.ts` applies one fixed effort fraction
  uniformly. Matters most for technical/mountainous courses. Real new
  state/dynamics and its own calibration need (short hard efforts, distinct
  from stage 3/4's VO2max-hunting).
- **Fat-oxidation ceiling rising as glycogen depletes.** `substrate.ts`'s
  `foPeakGPerMin` is a flat constant; established physiology says the
  crossover shifts rightward (more fat-friendly) as glycogen falls. Not
  modeled.
- **Terrain roughness penalty**, especially downhill — nothing tracks
  course technicality; Minetti's own paper flags treadmill-smooth data
  understating real-terrain cost.
- **Prediction intervals, not just a point estimate — built.** Planning
  mode used to output one deterministic finish time only. Before building
  anything, consulted on what the range should actually represent: a full
  Bayesian uncertainty quantification (or anything folding in day-of
  execution variance and structural model error) would need real-world
  calibration data this project doesn't have -- only two backtest
  residuals exist so far (-0.2%, -9.2%), nowhere near enough. Settled on a
  narrower, honest scope instead: a **fade-parameter sensitivity band** --
  how much the predicted finish time would shift if tau were slightly
  different, given how well the athlete's own training data actually pins
  it down. Explicitly NOT a real-world confidence interval; explicitly
  documented as excluding weather, fueling execution, and structural
  model error.

  `src/model/finishTimeRange.ts`'s `predictFinishTimeRange` bootstraps tau
  only (not the joint fInf/tau fit -- ~15-25x cheaper per call, and running
  the full 2-D search ~100 times would be too slow for an interactive
  button), holding fInf at whatever the point estimate resolved to. Reuses
  a newly-extracted `fitTauFInfWithSupportGate` (promoted from
  `scripts/backtestFinishTime.ts`'s own inline three-tier fallback) for
  both the point estimate and, cheaply, each resample. A resample that
  can't itself clear the same `informativeRaceCount` gate the point
  estimate had to clear is **skipped, not substituted with a default** --
  mixing "genuinely refit" and "fell back to defaults" samples in one
  distribution produces a bimodal, meaningless spread. This was a real
  risk flagged before writing any code: naive bootstrap-over-races is
  degenerate at low `informativeRaceCount` (exactly Soria Moria's real
  regime), and the fix generalizes directly from the guard already built
  for that case -- when the point estimate itself can't clear the gate,
  `predictFinishTimeRange` returns `null` (no band at all) rather than a
  falsely narrow or bimodal one.

  Verified with synthetic tests: null on an under-supported fit,
  monotonic low/median/high ordering plus full sample/skip accounting on a
  well-supported one, deterministic given the same seeded RNG, and (once a
  noiseless-synthetic-data trap was caught -- perfectly clean races all
  recover the same tau regardless of which get resampled, so real
  cross-race disagreement had to be injected to test this at all) a
  measurably narrower band from more informative races than fewer.

  Wired into the UI: `RunLibraryPanel` reports the races/raceDates behind
  its latest fit up to `App.tsx` via a new `onRacesFitted` callback; the
  Results tab's new `FinishTimeRangePanel` is an explicit on-demand button
  (bootstrap is too expensive for a live recompute-on-keystroke) showing
  either the band with its caveat text, or an insufficient-data message
  when `informativeRaceCount` is too low -- smoke-tested against a real
  dev server via headless Playwright.

  **Follow-up: a confidence interval on tau itself.** A CI on the fitted
  parameter is a cleaner statistical question than the finish-time band --
  "how much would tau vary across resamples of my own training data" needs
  no day-of/structural-error scoping the finish-time range needed, and
  needs no target course or solver at all. The bootstrap machinery already
  existed inside `predictFinishTimeRange`; it just discarded the resampled
  `tauMin` values after handing them to the solver. Extracted into
  `pacingFit.ts`'s `bootstrapTauConfidenceInterval` (same skip-don't-
  substitute-defaults discipline as before), which `finishTimeRange.ts` now
  calls as a first pass before running the solver on each retained tau
  sample -- one shared bootstrap loop instead of two. Surfaced directly in
  `RunLibraryPanel`'s Athlete tab next to the existing tau fit ("Estimate
  tau confidence interval"), reusing that fit's own races/raceDates with no
  need for a Planning course.

  **Follow-up: actionable "what would improve this fit" advice.** The fit
  already computed `informativeRaceCount`, `durationDiversityRatio`,
  `hitSearchBoundary`, and now the tau CI's own width -- but a caller had
  to interpret those numbers itself to know what to actually do.
  `pacingFit.ts`'s new `suggestFitImprovements` turns them into concrete
  advice: too few informative races -> add multi-hour efforts; low
  duration diversity -> add a race at least MIN_DURATION_DIVERSITY_RATIO x
  longer or shorter ("your long runs are too similar in length"); a hit
  search boundary -> add a longer/shorter run in that direction; a tau CI
  wider than ~30% of its own point estimate (a heuristic flag, not a
  calibrated threshold) -> add more, especially long, runs. Reports a
  reassuring "looks fine" entry when every check clears rather than an
  empty list. Surfaced as a combined "What would improve this fit?"
  section in the Athlete tab, next to the tau/fInf fits and the CI.
- Poles/hiking economy adjustment — real but niche.

**One citation flag:** the doc states Riegel's exponent runs "1.1–1.2+ for
ultras" as if literature-established. This session's own research for §12
checked that specific claim and found no peer-reviewed source for a
corrected ultra exponent — those numbers "circulate only in uncited
coaching blogs." Everything else checked (the CP 2-20min validity window,
Maunder/durability, the Minetti downhill/eccentric findings) independently
confirmed against sources already verified for §12.

**Disposition:** W′/CP, the glycogen-dependent fat ceiling, and terrain
roughness are logged as candidate future stages, each its own scope of
work — not folded into stage 4/5. Prediction intervals (above) are now
built. Proceeding with stage 4 as scoped, testing tau against descent load
specifically (not just generic "intensity") per the sharpened stage 5
target above.

---

## 14. Plan B — segment-level slowdown-factor regression (new fitting method)

**Goal (user request, 2026-07-23):** replace how the aerobic-fade part of the
model is fit. Everything through §13 fits parameters *indirectly*: pool
whole races, forward-simulate a candidate parameter set through the solver,
and search for the value whose predicted finish time best matches what
actually happened. That gives one usable data point per race (dozens of
races, at best). Plan B fits *directly*: cut every GPX in the athlete's
run library into segments that are internally consistent in grade and
surface, read off each segment's own speed and power, and regress pace
directly against a linear combination of slowdown factors — surface
(external) and aerobic fatigue + accumulated impact/distance (internal).
Thousands of segments across the whole library, not dozens of races.

**Confirmed with the user: Plan B replaces the tau/f0/fInf duration-decay
curve specifically** (`ceiling.ts`'s `sustainableFraction`), not the
surrounding architecture. `minetti.ts`'s cost curves, `substrate.ts`'s
glycogen model, and `solver.ts`'s forward-simulation/bisection-on-θ
machinery all stay. What changes is *what drives the power ceiling down
over the course of a race* — instead of an assumed exponential-decay shape
in elapsed time, it's whatever fatigue proxy this regression finds actually
explains the athlete's own pace decrement, wired in at the same
composition points `ceiling.ts`/`solver.ts` already expose (a ceiling-side
term for aerobic fatigue, a cost-multiplier-side term for impact — see
"Two internal channels, not one" below). Surface reuses the existing
`unpavedCostMultiplier` composition point in `solver.ts`/`analysis.ts`
directly; only *how its value is fit* changes.

### Why this can work where the whole-race approach struggled

§12 stage 5's within-race descent/fatigue diagnostics are the closest thing
already built to Plan B, and they're the honest reason for extra caution
here, not just optimism: the descent-vs-fade correlation *weakened* as more
data came in (-0.58 at n=7 whole-race-halves → -0.21 at n=16) — the
signature of small-sample noise fitting itself to a hypothesis, not a real
effect firming up. That diagnostic had, at best, ~16 data points (one
early/late split per race). A segment-level regression over the same
library has thousands — real statistical power to detect an effect that
size, if it's real, instead of reading tea leaves in n=16. But this cuts
both ways: if the effect really is that weak, more power will show that
clearly too, and Plan B should be prepared to report a genuine null on the
internal-fatigue side rather than manufacture a coefficient because the
regression can always produce *some* number.

### Stage 0 (gate, do this first): does measured power actually follow the Minetti curve?

This has never actually been tested end-to-end — it's an assumption the
whole model has run on since §2. It can't be tested using this app's own
`grossPowerWPerKg`: `analysis.ts`'s `analyzeRun` *derives* that number from
GPS speed via `costOfRunning`/`costOfWalking`, so comparing it back to the
Minetti curve is circular by construction (at fixed grade, model-power *is*
speed — this exact trap already burned the first pass at the path-surface
multiplier in §12 stage 6, "second attempt"). The only real test uses
**device power** (`CourseSegment.powerWatts`, e.g. Stryd — ~109 cached runs
already have it): compute `device-power / (speed × mass)` per segment and
check whether that traces `Cr(i)` across grade, restricted to *clean*
segments (paved surface, low cumulative fatigue/impact, moving not paused)
so surface and fatigue effects — the very things Plan B is about to
fit — don't contaminate the baseline it's fit against.

Caveat to carry into the read: Stryd's own power number comes from its own
internal biomechanical model (it isn't a direct force/velocity
measurement), so a shape mismatch could mean "Stryd's grade model disagrees
with Minetti's" rather than "this athlete disagrees with Minetti's." If the
shape doesn't hold even on clean segments, the whole premise — that power
minus a few explicit slowdown factors explains pace — needs rethinking
before any regression is worth building. This is a go/no-go gate, not a
diagnostic to note and move past.

**Real-data result (2026-07-23): pass — proceed, keep raw Minetti as the
baseline.** `scripts/testMinettiPowerShape.ts` (new; reads the existing
on-disk `.strava-cache/` activities directly, no live Strava session
needed; fetches surface once per activity from Valhalla's public endpoint
directly — no `vercel dev` required, since `api/surface.ts` needs no auth
— and caches responses forever in the new gitignored `.surface-cache/`)
ran against 203 cached activities with both device power and timestamps,
restricted to paved, moving, non-paused segments in the first 35% of each
activity's elapsed time: **6186 clean segments**, comparing
`powerWatts/bodyMassKg` (bodyMassKg=70 assumed — see note below) to
`grossMetabolicPower(Cr(i), speed)` at the same observed speed and grade.

The overall level (median ratio 0.42) is exactly the kind of flat
calibration constant expected and doesn't matter on its own — Stryd's
power definition isn't metabolic W/kg, so some constant offset was always
going to be there. The shape is the real question, and in the range that
actually carries statistical weight it holds well: from −10% to +5% grade
(n=139 to 3697 per bin, and — importantly, see below — running-gait-
dominant), the ratio moves only from 0.46 to 0.42, a modest ~9% relative
drift. Re-ran at three fatigue-window settings (20%, 35%, no filter at
all) to rule out a fatigue artifact: the trend was stable across all
three, so whatever it is, it isn't the fatigue filter creating it.

**A steeper apparent decline beyond +10% grade turned out to be a gait
confound, not a Minetti/athlete mismatch — caught by adding a walk%
column to the same table.** Beyond +10% grade the ratio does drop further
(0.40 at +10%, 0.38 at +15%, down to 0.13-0.32 above +20%) — but walk
fraction rises in exact lockstep: 29% walking at +10%, 43% at +15%, 71-100%
at +20% and above. Stryd's power algorithm is built and validated for
running gait; power-hiking segments are exactly where its own accuracy is
weakest, and that's also where sample size collapses (n=4-44 above +15%
vs. thousands below +10%). So the visually dramatic steep-grade decline is
best explained by "device power is least trustworthy exactly where the
athlete is walking," not by "this athlete's uphill running economy departs
from Minetti's" — the data can't actually distinguish those two, and the
gait/sample-size pattern favors the boring explanation.

**Verdict, kept deliberately narrow: the power↔grade↔speed relationship is
monotonic, non-degenerate, and — over the well-sampled, running-dominant
core — close to the flat calibration constant the premise needs. That's
enough to proceed. It is not independent confirmation that this athlete's
absolute grade-cost shape differs from Minetti's, and a single,
walking-contaminated, device-limited power source can't provide that
confirmation.** The correct response to "the shape can't be independently
validated from this data" is to keep the published, lab-validated Minetti
curve as Stage 2's fixed baseline — not to bend it toward an uncertain
device reading. If a grade-dependent correction is added at all, it goes
in as **one candidate regressor among others, on equal footing with
surface/fatigue/impact, earning its place only if it improves the same
held-out finish-time backtest every other mechanism in this file answers
to (§12 stage 5/6's own arbiter)** — never assumed up front from this
gate alone.

**Follow-up probe, not run yet, worth it if this athlete's own grade
economy specifically becomes a live question later:** bin real device
power itself (not the ratio) and look at how speed falls off with grade
*at matched power*, comparing against `1/Cr(i)`'s shape — the same
power-held-constant slice §12 stage 6's third attempt used for the
surface question, which is less confounded than dividing two
different-unit quantities by each other (still not clean with only one
power source, which is itself the argument for defaulting to "keep
Minetti" rather than chasing this further right now).

One methodology note carried forward: `bodyMassKg` was left at the generic
default (70) rather than this athlete's real mass — it only shifts the
overall calibration constant uniformly, not the shape, so it doesn't
affect the verdict above, but the *absolute* power numbers this script
prints (not the ratio-vs-grade trend) shouldn't be read literally until
the real mass is substituted.

### Two internal channels, not one

The user's two internal factors map onto two physiologically distinct,
already-separated composition points in this codebase, not one shared
"fatigue" number:

- **Aerobic fatigue** — reduces the *power the athlete can aerobically
  sustain*. This is what `ceiling.ts`'s duration curve already represents;
  Plan B changes what drives it (see next section), not where it plugs in.
- **Accumulated impact/distance** — muscular/eccentric load degrading
  *running economy* (more speed lost for the same power) rather than the
  aerobic ceiling itself. This is a cost-side multiplier, the same slot
  `unpavedCostMultiplier` occupies, and the same mechanism §12 stage 5's
  (reverted) cumulative-exposure durability term tried on the ceiling side —
  the fix there isn't the mechanism, it's putting it on the correct side
  (cost, not ceiling) and fitting it with enough statistical power to trust
  the answer either way.

**This two-channel split is this document's interpretation of the request,
not something the user specified directly — flag if a single combined
"fatigue" term was actually intended.** It's reconciled as one log-pace
regression either way (coefficients just get attributed to different
solver composition points), so it doesn't change the regression itself,
only where each fitted number plugs in afterward.

**Important dependency: separating the two channels requires device power,
and only on segments that have it.** On a Minetti-derived-power segment
(no Stryd/footpod), power is *defined* as `Cr(grade) × speed` — so "less
aerobic power available" and "same power, less speed from worse economy"
are the same observation, perfectly confounded, no regression can tell them
apart from that segment alone. The two channels are only separable either
(a) per-segment, where real device power lets `measured cost = powerWatts /
speed` be compared to the Minetti baseline directly and isolate the economy
channel, or (b) across runs, if the fatigue-proxy and impact-proxy end up
decorrelated enough in the pooled regression to pull apart on their own —
which runs straight into the same "this athlete's real training data sits
on a diagonal" decorrelation problem §11/§12 already found hard for
exactly this reason. Concretely: **of the long (duration-filtered) runs
stage 4 fits from, how many carry `powerWatts`?** Checked against the local
`.strava-cache/` activity cache (the script-side dataset the backtest tools
already use, not necessarily identical to the browser's IndexedDB run
library, but the best real proxy on hand): of 262 cached activities, 159
are ≥1h, and **122 of those 159 (77%)** carry at least one non-null power
point. That's a real majority — the per-segment separation path is
plausible on this athlete's actual data, not just a theoretical option —
though "has some power points" isn't the same as "has continuous power
coverage on the specific long monotonic segments stage 4 needs"; worth
rechecking at the segment level once the splitter exists, not just at the
whole-activity level checked here.

Conflating these into one "fatigue" scalar would re-create exactly the
tau/durabilityDriftPerHour collinearity problem §11/§13 already diagnosed
(two things that are "functions of the same clock" can't be told apart from
one signal) — keeping them on their existing separate composition points is
what makes them separable in principle. Whether the *data* actually
separates them is an open empirical question, not a given (see
Collinearity below).

### Segmentation: monotonic-grade + constant-surface runs

Default reading of "monotonous in grade and surface type" — flag for
correction if this isn't what was meant: a segment is a maximal run of
consecutive fixed-length pipeline segments (`CourseSegment`, already
resampled to `segmentLengthM`) where:
- `gradient` stays the same sign (uphill / downhill / flat), with a small
  hysteresis band (e.g. ±1-2%) around zero so GPS/elevation noise doesn't
  shatter a genuinely flat stretch into dozens of alternating micro-segments
  — this is the same noise-vs-signal tension §5 already resolved once for
  `smoothingWindowM`/`segmentLengthM`, not a new problem;
- `surfaceUnpaved` (or the finer Valhalla category, see below) stays constant;
- not paused, and **(confirmed with the user) also breaks on a walk/run
  gait change** (speed crossing `walkMaxMs`, same convention as
  everywhere else in this codebase) even if grade and surface don't
  change — gait is its own pacing decision, already modeled separately
  (§6), and a segment spanning a mid-climb run→walk transition would mix
  two different cost regimes into one averaged speed/power reading.

Each resulting segment carries: total distance, total time (→ average
speed), average recorded device power where available (else Minetti-implied
power, clearly flagged as which), average gradient, surface category, and —
carried over from the underlying fixed-length segments, computed *before*
this aggregation step, per the user's own framing — the internal-state
features below evaluated at the segment's start (matching
`EffortTrendPoint`'s existing "value at the start of this segment"
convention).

**Minimum segment length/duration floor (confirmed with the user): ~100m
or ~30s, whichever binds first.** Roughly 2x the pipeline's own 50m
resample spacing, so a qualifying segment always spans several underlying
fixed-length points (a stable speed/power average, not 1-2 noisy points)
without discarding most short rollers on typical rolling/trail terrain the
way a stricter floor (e.g. ~250m/60s) would. Still worth checking against
the real segment-length distribution once built — this is a starting
point, not a number derived from data yet.

**Surface granularity (confirmed with the user): start with the full
Valhalla vocabulary (paved/gravel/dirt/compacted/path), not binary.** §12
stage 6 found the full vocabulary didn't beat binary paved/unpaved *under
the finish-time-backtest objective* — but that's a different objective
from Plan B's (segment-level pace variance, not downstream finish-time
prediction), and the same section's real-device-power check already found
a genuine, non-circular, granularity-specific signal (path 9-31% slower
than paved at fixed power+gradient; gravel/dirt/compacted showed no
consistent pattern). Start fine-grained and let the regression's own fit
quality decide whether categories collapse for this objective, rather than
re-importing an answer from a different one.

### Internal fatigue proxy: candidates to test, not one to assume

The user asked to look in the literature rather than pick one blind. §12's
own literature sweep (critical-power/W′-balance modeling, central vs.
peripheral fatigue, Maunder's "durability" framing) already surveyed this
ground for the whole-race fit; the candidates below are the same research
read for segment-level use, kept as a shortlist to fit and compare — the
same "build every candidate, let a real backtest arbitrate" discipline
already used for the descent-exposure bases (§12 stage 4) and the
unpaved-cost mechanism (§12 stage 6), not a new methodology:

- **Elapsed time** — what the current tau/fInf curve already assumes.
  Cheapest baseline to beat; if nothing below beats it, that's a real
  result (the current shape was right), not a failure of the exercise.
- **Cumulative supra-threshold ("hard") work, `E_hard`** — §13's own
  sharpened recommendation from the mechanistic-model second-opinion
  review: integral of (power − LT2 power) over time, clamped at 0, rather
  than wall-clock time. Directly targets the Maunder/Tiller-Millet finding
  that fade tracks relative intensity and eccentric load, not elapsed time
  per se (§12 Q2).
- **W′-balance depletion state** (Skiba bi-exponential reconstitution
  model) — the standard critical-power-literature answer to "how fatigued
  is this athlete right now," tracking a depleting/recovering anaerobic-work
  reserve rather than a monotonic clock. Standard in cycling
  power-duration modeling; not previously applied in this project. Real
  cost: needs its own recovery-time-constant fit, one more thing this
  segment library may or may not identify well.
- **Cumulative mechanical work / distance** — simplest alternative to
  elapsed time that's still monotonic but decouples from the clock when
  pace varies (a fast early section and a slow one accumulate work/distance
  differently even over the same elapsed time) — partially addresses the
  collinearity problem below, though only partially, since work and time
  are still highly correlated in practice.

Fit each candidate's own coefficient against the segment library, compare
fit quality honestly (the same way `descentMeters`/`descentImpact`/
`descentImpactSquared` were compared, not picking a favorite up front), and
report which wins — including the honest possibility that plain elapsed
time wins and the added complexity of `E_hard`/W′-balance doesn't earn its
keep on this athlete's data.

### Three landmines to design around — two already documented elsewhere in this file, one found during Stage 0

- **Non-independence / clustering (found running Stage 0).** Stage 0's
  6186 segments are not independent draws — they're autocorrelated within
  a run (consecutive 50m segments share conditions) and clustered by run.
  The Stage 0 verdict itself doesn't lean on treating them as independent
  (it rests on direction + the running-core flatness + the walk-gait
  explanation, all robust to this), but Stage 3/4's actual slowdown
  regression will: naive OLS standard errors/R² computed over
  thousands-of-segments-as-if-independent will badly overstate precision,
  and "does this coefficient earn its place" depends on honest SEs. Treat
  *run* as the clustering unit — cluster-robust standard errors, or
  aggregate to one row per (run × bin) before fitting — rather than
  reporting per-segment significance at face value. Distinct from, and
  compounds with, the collinearity landmine below (that one is
  feature-vs-feature; this one is observation-vs-observation).
- **Collinearity.** Within a single run, elapsed time, cumulative work, and
  cumulative descent-impact all rise together — §11/§13 call this out
  repeatedly as "functions of the same clock." A segment library inherits
  this at the segment level exactly as the whole-race fits did at the race
  level. The pooled *cross-run* regression is the thing that can break it,
  and only to the extent the library's runs are genuinely diverse in
  duration/intensity/terrain mix — the same duration-diversity requirement
  §11 already needed for the fInf/tau fit, now needed for a design matrix
  instead of a race-duration spread. Check the design matrix's condition
  number (or per-feature VIF) once real segments exist, before trusting any
  individual coefficient — a well-fit regression with a near-singular
  design matrix is not evidence the mechanism is real.
- **Transfer from training runs to ultras.** §12 stage 6's third attempt
  found the momentary power-vs-speed relationship measured on ordinary
  training runs "doesn't capture what a 15-25 hour technical ultra actually
  costs" — fresh legs and familiar local trails understate what
  multi-hour accumulated fatigue and technical/night terrain actually do.
  This library is mostly short training runs plus a handful of long races
  (the same imbalance §12 stage 1 had to filter for the pooled fits) — a
  segment regression pooled naively across all of it will be dominated by
  short-run segments and will describe *training-run* slowdown, not
  *ultra* slowdown, exactly where the fatigue/impact terms matter most.
  Plan: fit **surface** from the full library (external, physically
  present regardless of run length or fatigue state — no reason to expect
  it not to transfer), but restrict the **fatigue/impact** terms to
  long-enough runs specifically, mirroring `DURABILITY_MIN_DURATION_S`'s
  existing 1-hour bar in `suggestRuns.ts`/`RunLibraryPanel.tsx` rather than
  inventing a new threshold from scratch.

One more honest framing carried over from §12 stage 6: this athlete's own
recorded effort fraction on unpaved terrain is flat-or-slightly-negative,
not elevated — they don't push harder there, they just move slower. That
means surface behaves partly as an observed *pacing choice* (footing,
navigation caution) as much as a pure metabolic-cost multiplier. Worth
keeping in mind when interpreting a fitted surface coefficient: it's "how
much slower this athlete goes," not necessarily "how much more this terrain
costs metabolically" — the distinction doesn't change where the multiplier
plugs into `solver.ts` (it's already specified as a pace/cost effect, not a
claimed metabolic mechanism), but it does matter for how confidently a
number like "1.8x on unpaved" gets described anywhere user-facing.

### Proposed staged build order

1. **Stage 0 gate above — done (2026-07-23).** Real device power vs.
   Minetti shape, clean segments only: pass (see result above) — proceed
   with raw Minetti as Stage 2's fixed baseline; a grade-dependent
   correction is at most a candidate regressor to test later, not a
   correction applied up front.
2. **Segmentation + feature extraction — done (2026-07-23).**
   `src/model/monotonicSegments.ts`'s `buildMonotonicSegments` splits a
   course's fixed-length `CourseSegment[]` into monotonic-grade
   (hysteresis-banded sign, per the confirmed design)/constant-surface/
   constant-gait runs, always breaking (and excluding) at a paused or
   untimed segment. Per run: distance, time, avg speed/gradient, surface
   category, gait, average measured (device) and Minetti-implied power/kg,
   and — evaluated *before* the run's own contribution, matching
   `EffortTrendPoint`'s convention — both internal-fatigue channels from
   §14's "two channels, not one" design:
   - **Aerobic-fatigue candidates** (ceiling-side): cumulative elapsed
     hours, cumulative distance, cumulative Minetti net work, and
     cumulative supra-LT2 "hard" work (opt-in via `ceilingParams`; W′-
     balance deliberately deferred, per §14's own note that it needs its
     own recovery-time-constant fit).
   - **Impact/muscular-fatigue candidates** (cost-side, added after the
     user flagged this field was still missing): four parallel readings,
     not three — the three descent-exposure bases already validated and
     shipped for the whole-race fits (cumulative descent meters,
     descent×speed, descent×speed²), computed via `descentImpact.ts`'s
     `descentStepForSegment` (reused, not reimplemented a fourth time,
     threading `previousElevation` across every segment including pauses,
     exactly matching that function's existing contract) — **plus a
     fourth, independently-sourced reading recovered when the user asked
     whether it had been carried over: `runningImpact.ts`'s "running
     impact" score (§12 stage 4's "Follow-up"), reverse-engineered against
     an athlete-facing app metric from real (distance, elevation, score)
     tuples, not the same hypothesis as the speed-weighted descent bases
     (distance + Minetti hill-surcharge vs. speed-weighted descent).**
     Accumulated incrementally by calling that module's own exported
     `hillSurchargeKm()` on each single segment rather than re-slicing the
     whole course per point (`hillSurchargeKm` has no "must start at
     course index 0" restriction, unlike `runningImpact()` itself, which
     is what makes the incremental form safe). One documented, expected-
     negligible divergence from that module's original validated usage:
     its distance term normally reads a course's raw `cumulativeDistance3D`
     (including whatever drift a paused segment accumulates), but this
     reuses the already-tracked moving-distance-only accumulator instead —
     a "paused" segment is classified that way precisely because its own
     distance is already near zero, so the practical difference should be
     tiny, but it isn't literally identical.

   `surfaceExposure.ts`'s `attachSurfaceData` was extended in the same pass
   to also set the new `CourseSegment.surfaceCategory` (the full Valhalla
   vocabulary — paved/gravel/dirt/compacted/path/other — confirmed above),
   alongside the existing binary `surfaceUnpaved` it already fed
   `unpavedCostMultiplier`; both fields now come from one lookup, so they
   can never disagree with each other. Verified with 17 synthetic-course
   tests (`monotonicSegments.test.ts`) before touching real data — grade/
   surface/gait boundary triggers, pause/untimed exclusion, the floor's
   OR-logic in both directions, cumulative-at-start correctness (all four
   channels), the `ceilingParams`/`bodyMassKg` opt-in gating, elevation
   continuity across a pause (a paused segment's own elevation drift must
   update the running "previous elevation" state without itself counting
   as descent — caught by a dedicated test after the general course-builder
   test helper turned out to have an off-by-one in when it stamped each
   segment's elevation, fixed before it could produce a silently-wrong
   expected value in the new descent tests), and the running-impact
   accumulation cross-checked directly against `hillSurchargeKm()` called
   on the equivalent course prefix (not just a hand-rederived formula).

   **Real-data sanity check** (`scripts/buildSegmentLibrarySample.ts`,
   offline — reuses Stage 0's `.surface-cache/`, no new Valhalla calls):
   203 activities → **8824 monotonic segments** (avg 43.5/activity).
   Distance p10/p50/p90 = 82/149/540m, duration p10/p50/p90 = 36/69/208s —
   comfortably above the 100m/30s floor at the median, not a pile-up of
   marginal segments. The floor itself drops **34.3%** of raw candidate
   runs (13,423 → 8,824) — a real, meaningful filter, not a no-op, but not
   so aggressive it's discarding most of the library either. All 5 surface
   categories are well-populated (gravel 42%, paved 27%, dirt 14%,
   compacted 11%, path 7% — even the smallest, path, has 619 segments).
   Gait split 72.5% run / 27.5% walk. Cumulative descent exposure reaches
   plausible, non-degenerate values across the library (max
   `cumulativeDescentMAtStart` seen: 4158m) — a sanity check only, not a
   per-activity summary (see the run-of-origin gap below).

   **Two things carried forward, not fixed now:**
   - **Segment output has no run-of-origin field.** `MonotonicSegment` only
     carries `startIndex`/`endIndex` *within* the activity it was built
     from; assembling a cross-run library (Stage 3/4) must tag each
     segment with its source run's id at that assembly step — needed
     specifically for this session's own clustering landmine (treat *run*
     as the clustering unit for cluster-robust SEs / per-run aggregation),
     which is impossible to retrofit onto an already-flattened segment
     list. Do this first when Stage 3/4 assembles the real library, not
     as an afterthought.
   - **The real-data check's "100% measured-power coverage" is a selection
     artifact, not a population statistic, and it cannot yet answer the
     two-channel question Stage 0 raised.** `.surface-cache/` only holds
     activities Stage 0 already pre-filtered to `hasPower && hasTime`, so
     this sample is selection-biased toward power-having, generally
     shorter activities. The number that actually matters for Stage 0's
     "is the two-channel split realizable?" question — device-power
     coverage on the duration-filtered *long* runs specifically, at
     segment granularity — is still unmeasured; don't read this 100% as
     evidence either way.
   - **Nit, intentional, worth remembering:** `gradeSignWithHysteresis`
     carries the previous sign through the dead zone, so a genuine
     sustained flat plateau immediately following a climb (with no gait or
     surface change to force a break) merges into that climb, blending its
     `avgGradient`. This is the confirmed, plain reading of "monotonic in
     grade" and the tests lock it in on purpose — flagged here so a future
     grade-bin residual oddity gets recognized rather than re-debugged from
     scratch.
3. **Surface regression across the full library — done (2026-07-23),
   and the real conclusion is not the one the first pass reached.**
   `src/model/segmentLibrary.ts`'s `buildSegmentLibrary` tags every
   monotonic segment with its source run's id (the gap Stage 2 flagged),
   feeding `src/model/surfaceCostAnalysis.ts`'s `buildSurfaceCostTable` /
   `summarizeAcrossGradeBins` — a grade-bin × surface-category table (not
   a single collapsed mean) comparing device-power-implied log-speed
   residuals, restricted to running gait by default. Both built to avoid
   the grade/gait confound directly: tabulating this athlete's real data
   first (before writing any fitting code) showed path averages ~10% grade
   vs. paved's ~3%, and is 53% walked vs. paved's 20% — exactly the
   confound that would make a single per-category mean blend "this terrain
   is slower" with "this terrain's segments happen to be steeper/more
   often walked." Verified with 10 synthetic tests (recovering an injected
   multiplier within one grade bin at matched power; correctly reporting
   `null`, not a spurious number, when a category never overlaps paved in
   any bin; run-count vs. segment-count; gait/power/surface filtering;
   weighted pooling across bins).

   **First real-data pass: near-null.** Across 8824 segments/203 runs,
   running-gait-only, the paved-relative implied cost multiplier came back
   close to 1.0 for every category (gravel 1.012, dirt 1.030, compacted
   1.020, path 0.999) — in sharp contrast to both the shipped whole-race
   `unpavedCostMultiplier` (~1.8-1.9x) and §12 stage 6's own earlier
   real-power finding (path 9-31% slower at matched power+gradient).

   **That near-null turned out to be an artifact of the instrument, not
   evidence of no effect — caught before writing it up, not after.**
   The residual this table computes reduces algebraically to comparing
   *device power* at matched speed+grade across surfaces (log(speed) −
   log(power/cost(grade)), held at fixed grade, is a comparison of
   speed-per-watt). Stryd's own power estimate is substantially derived
   from speed and grade in the first place — so if it doesn't independently
   respond to surface roughness (which a footpod, lacking any way to sense
   trail technicality, has no obvious reason to), the whole comparison is
   structurally blind, and a near-1.0 result reflects what the instrument
   *can* report, not what's physically happening. Checked directly, not
   assumed: `scripts/testStrydSurfaceSensitivity.ts` bins running segments
   by (grade, speed) — not grade alone, since this specifically asks "at
   the same pace and grade" — and compares mean device power across
   surfaces within each matched cell. Result: **1.01-1.03x across all four
   categories** — device power barely responds to surface at all when pace
   and grade are truly held fixed. The instrument is blind. This also
   retroactively explains why it disagreed with §12 stage 6's earlier
   device-power finding: both analyses used the same blind instrument,
   just with different (and apparently inconsistent) binning/confound
   handling — neither number was trustworthy, which is why they disagreed,
   not because one used a better method than the other.

   **Heart rate — not derived from speed or grade the way Stryd's power
   is — was checked next as a genuinely independent signal, and it found a
   real effect.** `scripts/testHrBySurface.ts` compares HR at matched
   (grade, speed) cells across surfaces, restricted to the early ~65% of
   each activity (same convention as `hrCalibration.ts`, to control
   cardiac drift). Pooled across all runs: gravel +4.7bpm, dirt +5.4bpm,
   compacted +6.3bpm, path +8.7bpm vs. paved, at matched pace and grade —
   real, orderly, and roughly tracking the terrain-difficulty ordering
   already found elsewhere in this project.

   **That pooled number has its own confound, caught before trusting it:
   road-run days vs. trail-run days, not just road vs. trail terrain.**
   Pooling matched cells across every activity compares HR from
   road-running days against HR from trail-running days — and day-to-day
   HR baseline swings 5-10bpm from heat, hydration, sleep, and cumulative
   fatigue, independent of surface, in a direction (trail/mountain days
   plausibly hotter/longer/more fatigued) that could account for much of
   the pooled effect. The same "pooled regression reflects cross-race
   differences, not the thing being fit" lesson §11's tau fit already
   required (pooling per-race squared slopes, not raw pooled regression)
   — applied here to HR instead of pacing slope. **The discriminating
   check: compare paved vs. each category only using cells from the SAME
   run (same day, same physiology), then pool those within-run
   comparisons.** There was enough mixed-surface data to run this for
   real (most of this athlete's runs aren't single-surface): gravel
   +2.5bpm (279 comparisons), dirt +3.3bpm (124), compacted +3.6bpm (105),
   path +8.3bpm (29) — **the ordering survives, and path's effect is
   essentially unchanged (+8.3 vs. the pooled +8.7)**, while gravel/dirt/
   compacted shrink by roughly half, meaning the pooled cross-run version
   *was* inflating those three via the day-level confound, but not
   inventing the effect outright — a real, if smaller, cost survives the
   correction for all four categories.

   **Net conclusion, and what it does (and doesn't) license:** this
   athlete really does appear to work harder — a genuine physiological
   cost, not just slower pacing choice — on rougher terrain at matched
   pace and grade, with path the largest and most robust effect and
   gravel/dirt/compacted smaller. Device power (Stryd) cannot be used to
   settle this question either way, which also means neither this
   session's near-null nor §12 stage 6's earlier 9-31% number should be
   trusted going forward. **This does NOT yet license a specific cost
   multiplier**: converting bpm into an effort-fraction or cost multiplier
   needs `hrCalibration.ts`'s own HR-to-effort fit, already documented
   there as R²=0.24 (weak) for this athlete — the bpm numbers are a real,
   ordered signal, not a precise multiplier to plug into `ceiling.ts` or
   `solver.ts`. **One caveat not yet checked:** HR lags true effort by
   ~20-45s (established in §11's own HR-calibration work); at ~50m/15-20s
   segments, a segment's HR partly reflects the preceding 1-3 segments'
   effort, and path — the steepest, most clustered category — is
   disproportionately likely to follow a climb, which could inflate
   exactly the category showing the largest effect. Not resolved here;
   flagged as an open gap before this result is leaned on further.

   **Where this leaves the shipped 1.8x `unpavedCostMultiplier`:** neither
   confirmed nor replaced by this stage. A real, ordered, within-run-
   robust surface-cost signal now exists (unlike before, when the only
   real-power-based finding was itself confounded) — that's new evidence
   the mechanism might be real, not proof of its exact magnitude. Any
   future attempt to convert this into a model term must go through
   Stage 5's held-out finish-time backtest, the same arbiter every other
   mechanism in this file answers to, not be adopted directly from a
   segment-level HR diagnostic.
4. **Fatigue/impact regression across the duration-filtered long-run
   subset — done (2026-07-23), and the effective sample size turned out to
   be much smaller than the segment library's own size implies.** Before
   writing any regression, checked the actual candidate pool: of 159
   cached activities ≥1h (`suggestRuns.ts`'s own `DURABILITY_MIN_DURATION_S`
   bar, not a new threshold), 122 also have device power — but device
   power is irrelevant here (this diagnostic runs on GPS-derived
   `grossPowerWPerKg`, the same basis `analysis.ts` already uses
   everywhere else, not Stryd). The real constraint is different: fatigue
   and impact accumulation are *per-run trajectories*, monotonic within a
   run, so slicing 159 long runs into thousands of monotonic segments
   doesn't create thousands of independent fatigue observations — it
   creates one early/late contrast per run, measured more precisely. That
   makes this stage closer to §12/§13's own within-race diagnostic than to
   a fresh segment-level regression, and its honest sample size is however
   many runs actually produce a usable diagnostic point, not the segment
   count.

   Extended `src/model/withinRaceDescentDiagnostic.ts` (the existing
   early/late-window residual-correlation machinery, unchanged in its own
   design) with the two aerobic-fatigue-clock candidates the shortlist
   hadn't tested yet — early-window cumulative Minetti net locomotion work
   and cumulative supra-LT2 "hard" work, both per km of the early window —
   correlated against the *same* late-window residual outcome the existing
   three descent bases and the running-impact score already use. The
   underlying cost/hard-work formula was pulled out of
   `monotonicSegments.ts` into a new shared primitive,
   `src/model/workAccumulation.ts` (`workStepForSegment` plus two
   whole-array reducers), mirroring `descentImpact.ts`'s own
   step-function-plus-reducer shape — `monotonicSegments.ts` now calls
   into it rather than computing the same formula inline a second time.
   17 new synthetic tests (10 for the new module, plus `monotonicSegments`
   and `segmentLibrary`'s existing 20 tests confirmed byte-identical after
   the refactor); 2 new within-race-diagnostic tests (a wiring
   cross-check against calling the reducers directly on the same early
   slice, and confirming the null-control race reads near-zero for these
   two candidates too, same as the four existing ones).

   **Real-data run** (`scripts/fitFatigueClockDiagnostic.ts`, offline, no
   surface cache needed): of 159 long-enough activities, only **16**
   cleared every diagnostic gate (a real single-race tau fit, and a late
   window with both enough points and enough of its own elapsed time) —
   confirming the "N is runs, not segments" concern was not hypothetical.
   Six-candidate correlation table, all against the same late-window
   residual:

   | predictor | r |
   |---|---|
   | early descent (m/km) | −0.206 |
   | early descent impact (speed-weighted) | −0.211 |
   | early descent impact (speed²-weighted) | −0.218 |
   | early running-impact score | +0.189 |
   | early cumulative net work | +0.112 |
   | early cumulative hard work | +0.194 |

   None of these clear even a loose significance bar at n=16 (roughly
   ±0.5 needed). Two things worth noting about this table rather than
   just the null result itself: **the descent-impact number (−0.211)
   reproduces §12 stage 4's own earlier finding at the same sample size
   (−0.21 at n=16) almost exactly** — a real cross-check that this
   session's independently-rebuilt segment/work pipeline agrees with the
   already-shipped one, not a new discovery. And **net/hard work carry a
   confound the other four don't**: both are Minetti-derived from the
   same GPS speed the residual's own numerator is built from, so an
   ordinary negative-split pacing choice (nothing pathological) mechanically
   produces both a higher early-work number and a more negative late
   residual — a positive-and-weak reading here is consistent with either
   "no real cumulative-work fatigue effect" or "too little signal at n=16
   to separate the effect from the pacing-choice artifact," and this
   diagnostic cannot tell those apart.

   **Conclusion, matching Stage 3's own discipline: no candidate is
   crowned a winner here.** At n=16, every candidate reads as noise-level.
   This does not mean none of these mechanisms are real — it means a
   within-run correlation at this sample size cannot arbitrate between
   them, the same conclusion Stage 3 reached for the surface cost
   multiplier's exact magnitude. Stage 6's held-out finish-time backtest,
   not this table, decides whether any of these six candidates earns a
   place in `ceiling.ts` in place of (or alongside) tau.
5. **The genuine linear-combination fit — done (2026-07-23).** Asked the
   user directly what a real "Stage 5" should test, since running the
   three untested Stage-4 candidates through the existing single-basis
   `durabilityDriftPerDescentUnit` backtest one at a time would only
   extend a bolt-on-correction pattern already used for the three descent
   bases, never actually deliver the linear-combination-of-slowdown-
   factors fit Plan B was originally scoped around. The user asked for
   exactly that, scoped down to one term per category at a time (one
   aerobic-fade clock, one impact/muscular-fade term, plus surface),
   fit *jointly* rather than sequentially, and pointed out the segment
   library (8824 segments, not 16 runs) should give this real degrees of
   freedom.

   **One design correction before writing any code, courtesy of a second
   opinion:** the natural-seeming choice was to make heart rate the
   dependent variable, reusing Stage 3's one validated non-blind
   instrument. Wrong call, caught before building — Stage 3's instrument-
   blindness problem was specific to a *power-residual* framing (device/
   GPS power is nearly tautological with speed+grade), not a property of
   pace itself. Pace is exactly what the solver predicts and exactly what
   a held-out finish-time backtest scores, "athlete slows on gravel" is
   directly observable in speed without needing HR as a proxy, and fitting
   HR would have forced converting coefficients back through
   `hrCalibration.ts`'s own weak R²=0.24 map before they meant anything in
   pace/cost units. Outcome is grade-adjusted pace instead: log(speed) +
   log(Minetti running cost at that segment's own grade) -- a GAP-style
   quantity, Stage-0-validated, with no instrument-blindness detour
   needed. HR remains an optional validation aside, not a dependent
   variable, anywhere in this fit.

   Built `src/model/linearSolve.ts` (this project's first general dense
   linear-algebra primitive — Gauss-Jordan solve, weighted least squares,
   and per-column Variance Inflation Factors; 11 synthetic tests) and
   `src/model/jointSlowdownFit.ts` on top of it: surface category (one
   dummy per category actually present in the data, vs. a paved
   reference — a category absent from a given slice, e.g. no "other"
   segments, must NOT get an all-zero dummy column, or the design goes
   singular for a reason that has nothing to do with real collinearity;
   caught by a failing synthetic test before it could bite on a smaller
   real-data slice), one chosen aerobic-fade-clock term, and one chosen
   impact term — all fit **jointly**, not sequentially, via WITHIN-RUN
   fixed effects (each run's own segments de-meaned before pooling,
   restricted to running gait so voluntary walk breaks don't get absorbed
   into the fatigue-clock coefficient — same "compare a run to itself"
   discipline as Stage 3/4, and specifically the fix for the bolt-on
   pattern's blind spot: a run that's simultaneously hard-early and
   descending-fast-early no longer lets one term's coefficient silently
   absorb variance that belongs to the other). 8 synthetic tests: recovers
   an injected surface offset / clock coefficient / impact coefficient in
   isolation, flags a high VIF when clock and impact are constructed
   near-collinear, returns null with no within-run variance, excludes
   walk-gait and undefined-surface segments, and excludes the hard-work
   basis specifically when `cumulativeHardWorkJPerKgAtStart` is null.

   **Real-data run** (`scripts/fitJointSlowdownModel.ts`, offline, reuses
   `.surface-cache/`): all 3 aerobic-clock × 4 impact-basis combinations
   (12 total), 8824 segments / 203 runs / 6400 rows surviving the running-
   gait + known-surface filter. Two very different stories in the same
   table:

   **Surface: robust, and now a real usable number Stage 3 couldn't
   produce.** The surface coefficients are close to identical across
   *all twelve* clock/impact combinations, with low VIF (1.1–1.4,
   nowhere near the collinearity concern threshold) — gravel ≈ −0.050,
   dirt ≈ −0.046, compacted ≈ −0.053 to −0.057, path ≈ −0.22 log-GAP
   (≈ e^−0.22 ≈ 0.80× pace, a ~20% grade-adjusted slowdown vs. paved).
   Unlike Stage 3's device-power attempt, this isn't blind to surface —
   pace visibly responds, and it responds the same way no matter which
   fatigue terms ride alongside it. **Caveat, the same one Stage 3
   flagged for HR:** this is pace, not directly metabolic cost — it
   cannot distinguish "the terrain costs more" from "the athlete
   deliberately runs more cautiously on technical footing," the same
   cost-vs-choice ambiguity every pace-based measure in this project
   carries. For a *pacing predictor* that ambiguity doesn't matter (the
   solver only needs to predict pace, not explain why it changes) — but
   it means this number should be described as "how much slower this
   athlete actually runs on X terrain," not "X terrain's metabolic cost."

   **Aerobic-fade clock vs. impact: the collinearity risk materialized,
   mostly.** VIF on the clock/impact pair ranges from a well-separated
   ~1.0–2.0 (every `hardWork` combination, and the three
   `descentImpactSquared` combinations) up to ~9 (`elapsedHours`/`netWork`
   against the three descent bases) to a completely unusable 44–408
   (`elapsedHours`+`runningImpact`, `netWork`+`runningImpact` — these two
   terms are essentially measuring the same thing within a run and can't
   be separated at all). Where VIF is low enough to trust a coefficient,
   the coefficient itself is negligible: `hardWork`'s own coefficient is
   ~1–2×10⁻⁶ against every impact basis, indistinguishable from zero —
   clean because both terms are genuinely uncorrelated *and* both are
   close to no-effect in this data, not clean because a real signal
   survived. Within-run R² contributed by clock+impact+surface together
   is only 0.028–0.036 throughout. **Net: more segments (8824 vs. Stage
   4's 16 run-level points) sharpened the surface estimate exactly as
   the user expected, but did not resolve the clock-vs-impact
   identification problem** — that problem is structural (both
   accumulate ~monotonically within a run) and isn't fixed by segment
   count, confirming the advisor's distinction between "3 terms segment-
   rich, 1 still run-count-limited" rather than reversing Stage 4's
   conclusion.

   **What this does and doesn't license:** a candidate, well-cross-
   validated surface multiplier now exists, ready to carry into Stage 6's
   held-out backtest as a real ceiling/cost term. The aerobic-fade and
   impact channels still have no candidate coefficient worth trusting —
   this in-sample joint fit, like every one before it in this project, is
   not the arbiter of that; Stage 6 is.
6. **Held-out backtest** — same arbiter every other mechanism in this file
   answers to: refit on a training subset of races, predict a held-out
   race's finish time through the *existing* solver with the new
   ceiling/cost terms wired in, compare against actual. A good in-sample
   regression fit is not sufficient on its own (§12 stage 5's own
   "in-sample fit is close to guaranteed by construction" caveat applies
   here too) — only this step decides whether Plan B's fitted terms replace
   tau/f0/fInf in `ceiling.ts`, or whether the honest result is "the old
   curve was fine, this didn't beat it." Should verify the real backtest
   population directly (likely closer to §12's own ~47-race figure than
   Stage 4's n=16 — that gate was specific to the within-race diagnostic,
   not a ceiling on how many races have a known finish time to predict)
   before scoping it, and should let each candidate's coefficients be
   *fit* on the training fold rather than requiring in-sample
   significance first — the backtest is the significance test that works
   at a sample size too small to separate candidates any other way.

### Open questions

**Resolved with the user (2026-07-23):** segmentation also breaks on a
walk/run gait change (not just grade-sign/surface); surface starts at the
full Valhalla vocabulary, not binary; minimum segment floor starts at
~100m/~30s, whichever binds first. All three folded into the sections
above.

Still open:

- Segmentation's same-signed-run-with-hysteresis reading of "monotonic in
  grade" — flag if a stricter definition was actually meant.
- Whether `E_hard`/W′-balance's own extra parameters (LT2 power for the
  clamp, W′-balance's recovery time constant) get fit jointly with the
  slowdown regression or fixed from the athlete's already-configured
  LT1/LT2 inputs first — leaning toward fixing them (same "hold the
  lab-measured constants, fit only the latent coefficient" regularization
  discipline §13 already confirmed this project follows), but not decided.
