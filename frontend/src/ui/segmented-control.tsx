import { useId, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type SegmentedOption = { value: string; label: ReactNode };
export type SegmentedControlProps = {
  name: string;
  legend: string;
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "md" | "sm";
  className?: string;
};

export function SegmentedControl({
  name,
  legend,
  options,
  value,
  onChange,
  size = "md",
  className,
}: SegmentedControlProps) {
  const groupId = useId();
  const itemSize = size === "md" ? "min-h-11 px-3 text-sm" : "min-h-9 px-2.5 text-[13px]";

  function handleKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;

    const index = options.findIndex((option) => option.value === target.value);
    if (index < 0 || options.length < 2) return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = (index + direction + options.length) % options.length;
    const next = options[nextIndex];
    document.getElementById(`${groupId}-${nextIndex}`)?.focus();
    onChange(next.value);
  }

  return (
    <fieldset onKeyDown={handleKeyDown} className={cx("min-w-0", className)}>
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex max-w-full rounded-xl bg-sunken p-1">
        {options.map((option, index) => {
          const selected = option.value === value;
          const inputId = `${groupId}-${index}`;
          return (
            <label
              key={option.value}
              className={cx(
                "relative flex cursor-pointer items-center justify-center rounded-lg font-medium transition-colors",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink",
                itemSize,
                selected ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              <input
                id={inputId}
                className="sr-only"
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
