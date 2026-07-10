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
2. **Pooled tau-only ceiling fit — built, joint (f0, fInf, tau) fit
   deliberately deferred.** `fitTauAcrossRaces` in `pacingFit.ts` extends the
   single-race tau search across several selected runs at once: each race's
   own within-race slope is computed separately and the search minimizes the
   *sum of squared per-race slopes*, not one regression over concatenated
   points (races run on different days at different average efforts, so a
   pooled regression would mostly reflect cross-race effort differences, not
   fatigue shape). The search range still scales from the shortest/longest
   selected race's own duration, not a flat constant.

   The original plan here was a joint 3D (f0, fInf, tau) search, reasoned to
   be identifiable once races span different durations. An advisor review
   caught two problems before that got built: (a) the within-race-slope
   objective is scale-invariant — a flat ceiling (`fInf = f0 = c`) zeroes
   every race's slope for *any* c, so the sustained level `c` (which is what
   actually drives Planning's finish-time predictions) is a free direction
   under this loss; fitting f0/fInf needs an added level-anchor term (e.g.
   the LT2-capped plateau at the very start of a race), which doesn't exist
   yet. (b) it needs races that actually span a wide duration range (roughly
   2×+) to separate f0 from fInf — the two real races used to validate this
   stage were both ~7-8.5h, so on real data today there'd be no signal for
   the extra two parameters anyway, just extra degenerate directions. Revisit
   the 3-param fit once both a level-anchor term exists and the library holds
   races of meaningfully different lengths (a several-hour race plus
   something much shorter or a multi-day one) — until then, surfacing a
   fitted f0/fInf as authoritative would be overclaiming what the data
   supports.
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
   longest few, since descent variety is what stage 4's diagnostic needs. A
   handful of genuinely useful runs can be approved and fetched without
   scanning hundreds of rows or risking Strava's rate limit. See
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
5. **Descent/eccentric-load-dependent durability term** (only if stage 4
   shows a real signal). Not yet built. Sharpened by an independent design
   review (§13): key durability to cumulative descent/eccentric work
   instead of `durabilityDriftPerHour`'s current linear-in-elapsed-time
   form, which is collinear with tau's own exponential decay — not a vaguer
   "intensity-dependent" redesign. Still research territory, no established
   formula to copy; start narrow (e.g. a term that shrinks the ceiling as a
   function of cumulative descent, alongside — not replacing — the existing
   time-based fade) rather than a full central/peripheral two-component
   model in one step.

Stages 1-4 are done and well-supported by existing literature, directly
extending code that already existed. Stage 4's result (run it in the app —
needs at least 3 already-fetched runs) is what decides whether stage 5,
which is explicitly exploratory, is worth building at all — flag any result
from it as such in the UI, the same way the single-race tau fit already
flags negative-split ambiguity. Stage 5's target has since been sharpened by
an independent design review —
see §13.

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
- **Prediction intervals, not just a point estimate.** Planning mode
  outputs one deterministic finish time. Bayesian uncertainty
  quantification on the fade *coefficients* is a distinct idea from the
  time-varying-tracking Bayesian approach §12 already rejected (Marchal et
  al. 2025) — that rejection was about tracking drift over months, not
  about uncertainty on a single calibration fit.
- Poles/hiking economy adjustment — real but niche.

**One citation flag:** the doc states Riegel's exponent runs "1.1–1.2+ for
ultras" as if literature-established. This session's own research for §12
checked that specific claim and found no peer-reviewed source for a
corrected ultra exponent — those numbers "circulate only in uncited
coaching blogs." Everything else checked (the CP 2-20min validity window,
Maunder/durability, the Minetti downhill/eccentric findings) independently
confirmed against sources already verified for §12.

**Disposition:** W′/CP, the glycogen-dependent fat ceiling, terrain
roughness, and prediction intervals are logged as candidate future stages,
each its own scope of work — not folded into stage 4/5. Proceeding with
stage 4 as scoped, testing tau against descent load specifically (not just
generic "intensity") per the sharpened stage 5 target above.
