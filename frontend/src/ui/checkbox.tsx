import { useId, type ChangeEventHandler, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange" | "value"
> & {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
};

export function Checkbox({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  className,
  id,
  ...props
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const labelId = `${inputId}-label`;

  return (
    <label
      htmlFor={inputId}
      className={cx(
        "flex min-h-11 cursor-pointer items-center gap-3 py-2.5",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <input
        {...props}
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : props["aria-describedby"]}
        className="size-[18px] shrink-0 accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      />
      <span className="flex min-w-0 flex-col">
        <span id={labelId} className="text-[15px] font-medium text-ink">
          {label}
        </span>
        {hint && (
          <span id={hintId} className="text-[13px] text-muted">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
