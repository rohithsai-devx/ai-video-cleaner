import { useId, type ChangeEventHandler, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

export type SwitchProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange" | "value"
> & {
  label: string;
  hint: string;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
};

export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  className,
  id,
  ...props
}: SwitchProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const labelId = `${inputId}-label`;
  const describedBy = [props["aria-describedby"], hintId]
    .filter((id): id is string => Boolean(id))
    .join(" ");

  return (
    <label
      htmlFor={inputId}
      className={cx(
        "flex min-h-11 cursor-pointer items-start gap-3.5 rounded-2xl bg-accent-soft p-3.5",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center">
        <input
          {...props}
          id={inputId}
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={cx(
            "relative h-5 w-9 rounded-full transition-colors",
            "after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform after:content-['']",
            checked ? "bg-ink after:translate-x-4" : "bg-line-strong",
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink",
            disabled && "peer-disabled:opacity-60",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span id={labelId} className="text-[15px] font-medium text-ink">
          {label}
        </span>
        <span id={hintId} className="text-[13px] text-muted">
          {hint}
        </span>
      </span>
    </label>
  );
}
