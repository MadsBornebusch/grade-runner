// What to do in each strength session, by focus (planGenerator.ts's
// strengthFocuses). Equipment: a barbell and a few dumbbells. "Heavy" is
// a weight you could lift about two more times than the reps asked for
// (roughly 85% of a one-rep max at 4-6 reps): Eihara et al. 2022 found
// near-maximal loads improved running economy most. Exercises are listed
// most important first, so a short session drops from the bottom.
import type { StrengthFocus } from "../../plan/planGenerator";

export interface Exercise {
  name: string;
  /** "4 × 5", "3 × 8 each leg". */
  dose: string;
  note?: string;
}

export interface StrengthWorkout {
  title: string;
  /** One line on the session's point and how hard it should feel. */
  intro: string;
  exercises: Exercise[];
  rest: string;
}

export const STRENGTH_FOCUS_TITLE: Record<StrengthFocus, string> = {
  general: "General strength",
  heavy: "Heavy",
  heavyJumps: "Heavy + jumps",
  maintenance: "Keep strength",
  power: "Jumps + single leg",
  circuit: "Leg endurance circuit",
  deload: "Heavy, half volume",
  sharpen: "Short and sharp",
};

const WORKOUTS: Record<StrengthFocus, StrengthWorkout> = {
  general: {
    title: STRENGTH_FOCUS_TITLE.general,
    intro: "Learn the lifts and get the tendons used to load before going heavy. Moderate weights, stop 2–3 reps short of failure.",
    exercises: [
      { name: "Goblet squat", dose: "3 × 10–12", note: "Dumbbell at the chest. Move on to the barbell once this is easy." },
      { name: "Dumbbell Romanian deadlift", dose: "3 × 10–12", note: "Hinge at the hips, soft knees, flat back." },
      { name: "Dumbbell step-up", dose: "3 × 10 each leg", note: "Box about knee height. Push through the front leg only." },
      { name: "Single-leg calf raise", dose: "3 × 15 each leg", note: "Straight knee, full range, on a step." },
      { name: "Side plank", dose: "2 × 30–45 s each side" },
    ],
    rest: "1–1.5 min between sets.",
  },
  heavy: {
    title: STRENGTH_FOCUS_TITLE.heavy,
    intro: "The session with the best evidence for running economy. Heavy and few reps: you could do about two more, never to failure. Add weight when the last set feels easy.",
    exercises: [
      { name: "Barbell back squat", dose: "4 × 4–6" },
      { name: "Barbell Romanian deadlift", dose: "3 × 5" },
      { name: "Heavy dumbbell step-up", dose: "3 × 6 each leg", note: "Box about knee height." },
      { name: "Single-leg calf raise", dose: "3 × 8 each leg", note: "Hold a heavy dumbbell. Straight knee." },
    ],
    rest: "2–3 min between sets.",
  },
  heavyJumps: {
    title: STRENGTH_FOCUS_TITLE.heavyJumps,
    intro: "Jumps first while you're fresh, then heavy single-leg work. Every jump fast and springy; stop a set when they slow down.",
    exercises: [
      { name: "Box jump", dose: "3 × 5", note: "Low box. Step down, don't jump down." },
      { name: "Pogo hops", dose: "3 × 15", note: "Small, stiff-ankle hops on the balls of the feet." },
      { name: "Dumbbell Bulgarian split squat", dose: "3 × 6 each leg", note: "Rear foot on a bench, heavy dumbbells." },
      { name: "Barbell deadlift", dose: "3 × 4–5" },
      { name: "Bent-knee calf raise", dose: "3 × 10 each leg", note: "Seated, dumbbell on the knee: works the soleus." },
    ],
    rest: "1 min between jump sets, 2–3 min between heavy sets.",
  },
  maintenance: {
    title: STRENGTH_FOCUS_TITLE.maintenance,
    intro: "Keep what the heavy weeks built with as little fatigue as possible: few sets, same heavy weights.",
    exercises: [
      { name: "Barbell back squat", dose: "2 × 5", note: "Your usual heavy weight." },
      { name: "Barbell Romanian deadlift", dose: "2 × 5" },
      { name: "Single-leg calf raise", dose: "2 × 8 each leg", note: "Hold a heavy dumbbell." },
    ],
    rest: "2–3 min between sets.",
  },
  power: {
    title: STRENGTH_FOCUS_TITLE.power,
    intro: "Springy legs and single-leg control. Short and fast; your weighted hike covers leg endurance this week.",
    exercises: [
      { name: "Box jump", dose: "3 × 5", note: "Low box. Step down." },
      { name: "Bounding", dose: "3 × 6 each leg", note: "Long, springy strides on grass or a track." },
      { name: "Dumbbell Bulgarian split squat", dose: "2 × 6 each leg" },
      { name: "Slow step-down", dose: "2 × 8 each leg", note: "3 s down from a box: the braking you do on descents." },
    ],
    rest: "1–2 min between sets.",
  },
  circuit: {
    title: STRENGTH_FOCUS_TITLE.circuit,
    intro: "Leg endurance for long climbs and descents, for weeks without the weighted hike. Light dumbbells; legs should burn while breathing stays easy. Shorten the rest over the weeks rather than adding weight.",
    exercises: [
      { name: "Dumbbell step-up", dose: "10 each leg", note: "Box about knee height." },
      { name: "Step-down", dose: "10 each leg", note: "Slow, controlled lowering." },
      { name: "Walking lunge", dose: "10 each leg" },
      { name: "Squat jump", dose: "10" },
    ],
    rest: "Straight through, 3–4 rounds. Start with 2 min between rounds, work down to 30 s.",
  },
  deload: {
    title: STRENGTH_FOCUS_TITLE.deload,
    intro: "Same weights as usual, half the sets. Leave the gym feeling better than you came.",
    exercises: [
      { name: "Barbell back squat", dose: "2 × 4–6" },
      { name: "Barbell Romanian deadlift", dose: "2 × 5" },
      { name: "Single-leg calf raise", dose: "2 × 8 each leg" },
    ],
    rest: "2–3 min between sets.",
  },
  sharpen: {
    title: STRENGTH_FOCUS_TITLE.sharpen,
    intro: "The last strength session before the race. A few heavy reps keep you sharp; nothing that leaves you sore.",
    exercises: [
      { name: "Barbell back squat", dose: "2 × 3", note: "Your usual weight, fast up." },
      { name: "Box jump", dose: "2 × 3" },
      { name: "Single-leg calf raise", dose: "2 × 6 each leg" },
    ],
    rest: "2–3 min between sets.",
  },
};

/** Older plans have no focus: treat them as general strength. */
export function strengthWorkout(focus: StrengthFocus | undefined): StrengthWorkout {
  return WORKOUTS[focus ?? "general"];
}
