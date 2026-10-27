import { useId, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type RadioOption = {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
};

export type RadioGroupProps = {
  name: string;
  legend: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export function RadioGroup({ name, legend, options, value, onChange, className }: RadioGroupProps) {
  const groupId = useId();

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
    <fieldset
      role="radiogroup"
      onKeyDown={handleKeyDown}
      className={cx("min-w-0 space-y-2", className)}
    >
      <legend className="mb-2 text-sm font-medium text-ink">{legend}</legend>
      {options.map((option, index) => {
        const selected = option.value === value;
        const inputId = `${groupId}-${index}`;
        const hintId = `${inputId}-hint`;
        const labelId = `${inputId}-label`;
        return (
          <div
            key={option.value}
            className={cx(
              "flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2.5",
              selected ? "border-ink bg-surface" : "border-line bg-surface",
            )}
          >
            <label
              htmlFor={inputId}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
            >
              <input
                id={inputId}
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                aria-labelledby={labelId}
                aria-describedby={option.hint ? hintId : undefined}
                onChange={() => onChange(option.value)}
                className="size-[18px] shrink-0 accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
              <span className="flex min-w-0 flex-col">
                <span id={labelId} className="text-sm font-medium text-ink">
                  {option.label}
                </span>
                {option.hint && (
                  <span id={hintId} className="text-[13px] text-muted">
                    {option.hint}
                  </span>
                )}
              </span>
            </label>
            {option.action}
          </div>
        );
      })}
    </fieldset>
  );
}
