import { CalendarDots, Footprints, GearSix, Mountains, SunHorizon, type Icon } from "@phosphor-icons/react";
import type { TabId } from "./useHashRoute";

const TABS: { id: TabId; label: string; icon: Icon }[] = [
  { id: "today", label: "Today", icon: SunHorizon },
  { id: "runs", label: "Runs", icon: Footprints },
  { id: "schedule", label: "Schedule", icon: CalendarDots },
  { id: "race", label: "Goal race", icon: Mountains },
  { id: "settings", label: "Settings", icon: GearSix },
];

interface TabBarProps {
  active: TabId;
  onSelect: (tab: TabId) => void;
  /** Tabs that carry a dot, e.g. Runs when a model update failed. */
  badges?: Partial<Record<TabId, string>>;
}

/** Bottom tab bar on phones, a left side rail from 900 px (CSS only). */
export function TabBar({ active, onSelect, badges = {} }: TabBarProps) {
  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar__brand" aria-hidden="true">
        <Mountains size={26} weight="fill" />
      </div>
      {TABS.map(({ id, label, icon: TabIcon }) => {
        const isActive = id === active;
        const badge = badges[id];
        return (
          <a
            key={id}
            href={`#/${id}`}
            className={`tabbar__item tabbar__item--${id}${isActive ? " tabbar__item--active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            aria-label={badge ? `${label} (${badge})` : undefined}
            onClick={(e) => {
              e.preventDefault();
              onSelect(id);
            }}
          >
            <span className="tabbar__pill">
              <TabIcon size={26} weight={isActive ? "fill" : "duotone"} />
              {badge && <span className="tabbar__badge" aria-hidden="true" />}
            </span>
            <span className="tabbar__label">{label}</span>
          </a>
        );
      })}
    </nav>
  );
}
