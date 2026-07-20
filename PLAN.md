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
  `dGly/dt = carb_in_ox − carb_demand`, floored at reserve (~60 g).
  Exogenous carb is **gut-limited independent of intake**:
  `carb_in_ox = min(intake_g_per_h, gut_max)`, `gut_max ≈ 60 g/h` (glucose) to
  ~90 g/h (glucose+fructose). Intake above gut_max is wasted (GI distress), not fuel.
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

---

## 7. User-editable parameters & zero-input defaults

| Param | Default | Notes |
|---|---|---|
| Body mass | 70 kg | |
| VO₂max | 50 ml/kg/min | or infer from a recent race |
| LT1 / LT2 (%VO₂max) | 0.65 / 0.85 | anchors fat curve + ceiling cap |
| Duration→fraction curve | f0 0.94, f_inf 0.38, τ 250 min | calibrate to one race |
| Carb intake | 60 g/h | fueling plan |
| Gut oxidation max | 60 g/h (90 mixed) | caps exogenous carb, separate from intake |
| Glycogen store | ~7–8 g/kg ⇒ ~500 g | + fed/fasted start fraction |
| Glycogen reserve floor | 60 g | bonk threshold |
| FO_peak (fat rate ceiling) | 0.55 g/min | ~1.0 for elites |
| Resting metabolism | 1.2 W/kg | net→gross bridge |
| Walk max speed / force-walk grade | 2.0 m/s / off | |
| Smoothing window / segment length | 150 m / 50 m | see §5 GPX pipeline note re: why 150, not 40 |
| Altitude adjustment | on | Cerretelli per-segment |
| Durability drift | off | decay Ė_sus over hours |

Everything above the fold works with zero physiology input; accuracy improves as the
user supplies LT1/LT2, fat-ox points, and a calibration race.

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
3. **HR↔power/pace calibration** (optional stage). From any stored run with
   both power/pace *and* HR, fit a per-athlete mapping (e.g. HR zone → power
   fraction), restricted to the early, drift-minimal portion of each race.
   Lets a *future* HR-only run (no footpod) still get a reasonable effort
   estimate, with lower confidence flagged.
4. **HR zone inputs on the Athlete page.** Threshold HR and/or max HR fields,
   a zone-model selector (%HRmax / %HRR-Karvonen / %LTHR / fully custom
   boundaries in bpm) — mirrors the existing LT1/LT2-as-fraction pattern, so
   it slots into the same mental model rather than introducing a competing
   one.
5. **Fat/carb-ox curve reuse.** Already supported as a manual input
   (`equivalentLT1LT2`, `resolveSubstrateAnchors`); a stored run with HR could
   optionally attach a per-point HR value to each measured fat/carb-ox point,
   letting a future run's HR data map onto the *same* curve via the HR↔effort
   calibration from stage 3, instead of needing power for every future run.

Stages 1–2 are done and are the highest-value, least confounded by the HR
caveats above — they work purely from power/pace data already being parsed.
Stages 3–5 (not yet built) add HR-specific value but inherit the drift
caveat, so they're framed as "lower-confidence, HR-only fallback," not a
replacement.

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

   **Follow-up: "running impact" metric built; checked for the same
   fade signal — unstable, no reliable finding either way.** Separately
   from the descent-eccentric-loading work above, reverse-engineered an
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
   the descent metrics already get. First real finding, before touching any
   data: this metric's predicted sign is the *opposite* of the descent
   metrics'. Its hill-surcharge term comes from Minetti *metabolic* cost,
   where gentle-to-moderate descent is cheaper than flat running — so
   within the range most real descents fall in, steeper descent scores
   *lower* on this metric even as a genuine eccentric-damage effect would
   make the late-window residual more negative. The two move together, so
   a real muscular-fade effect would show up as a *positive* correlation
   here, not negative — locked in via a synthetic test using gradients that
   stay inside the monotonic region of the cost curve (it stops being
   monotonic in gradient past roughly -20%, where the curve bottoms out).

   Run against real data via `scripts/testRealStravaFit.ts`: the
   correlation is not just weak but genuinely unstable — three different
   (overlapping but not identical) real race samples of similar size gave
   +0.58 (n=6), -0.76 (n=7), and -0.89 (n=8), swinging through a full sign
   reversal depending on which few races happened to clear the within-race
   diagnostic's support gate. That instability, not any one of those
   numbers, is the finding: at the current sample sizes (6-8 races), this
   metric gives no reliable read in either direction, and the sign
   ambiguity above means even a stable correlation would need care to
   interpret (a negative reading wouldn't confirm the hypothesis the way it
   does for the descent metrics — it would need explaining away). No
   durability-term change follows from this; treat it as a documented,
   tested-but-inconclusive check, same disposition as the untaken
   descent-weighting hypothesis above.
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

Stages 1-5 are now built. Stages 1-4 (plus the avgIntensity/within-race
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
review — see §13.

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
