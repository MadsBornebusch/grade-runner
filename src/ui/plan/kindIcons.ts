import { Backpack, Barbell, Couch, FlagCheckered, Lightning, Path, PersonSimpleRun, TrendDown, type Icon } from "@phosphor-icons/react";
import type { SessionKind } from "../../plan/planGenerator";

export const KIND_ICON: Record<SessionKind | "rest", Icon> = {
  long: Path,
  easy: PersonSimpleRun,
  quality: Lightning,
  descent: TrendDown,
  hike: Backpack,
  strength: Barbell,
  race: FlagCheckered,
  rest: Couch,
};
