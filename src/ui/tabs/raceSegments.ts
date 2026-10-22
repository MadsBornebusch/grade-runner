export type RaceSegment = "course" | "pacing" | "analyze";
export const RACE_SEGMENTS: { id: RaceSegment; label: string }[] = [
  { id: "course", label: "Course" },
  { id: "pacing", label: "Pacing" },
  { id: "analyze", label: "Analyze" },
];
