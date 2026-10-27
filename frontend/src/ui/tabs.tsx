import { useId, type KeyboardEvent, type ReactNode } from "react";
import type { BadgeProps } from "./badge";
import { Badge } from "./badge";
import { cx } from "./cx";

export type Tab = {
  id: string;
  label: ReactNode;
  count?: number;
  countTone?: BadgeProps["tone"];
};

export type TabsProps = {
  label: string;
  tabs: Tab[];
  value: string;
  onChange: (value: string) => void;
  children: Record<string, ReactNode>;
  className?: string;
};

export function Tabs({ label, tabs, value, onChange, children, className }: TabsProps) {
  const id = useId();
  const selectedTabId = tabs.some((tab) => tab.id === value) ? value : tabs[0]?.id;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    document.getElementById(`${id}-tab-${next.id}`)?.focus();
    onChange(next.id);
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className="flex min-w-0 gap-6 overflow-x-auto border-b border-line"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === selectedTabId;
          return (
            <button
              key={tab.id}
              id={`${id}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={
                typeof tab.label === "string" && tab.count !== undefined
                  ? `${tab.label} ${tab.count}`
                  : undefined
              }
              aria-controls={`${id}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cx(
                "inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-0.5 text-sm font-medium transition-colors",
                selected ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink",
              )}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <Badge
                  tone={tab.countTone ?? (index === 0 && tab.count > 0 ? "warning" : "neutral")}
                >
                  {tab.count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${id}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${tab.id}`}
          hidden={tab.id !== selectedTabId}
          className="pt-4"
        >
          {children[tab.id]}
        </div>
      ))}
    </div>
  );
}
