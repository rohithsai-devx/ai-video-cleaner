import { useId, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function Field({ label, error, id, className, ...props }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const errorId = `${inputId}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cx(
          "min-h-11 rounded-xl border bg-surface px-3.5 text-sm text-ink placeholder:text-faint",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
