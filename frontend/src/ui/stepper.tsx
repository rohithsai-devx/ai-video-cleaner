import { cx } from "./cx";

export type StepState = "done" | "current" | "failed" | "next";
export type Step = { label: string; detail?: string; state: StepState };

const stateLabels: Record<StepState, string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  next: "next",
};

export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((step, index) => (
        <li
          key={`${step.label}-${index}`}
          aria-current={step.state === "current" ? "step" : undefined}
          className="relative flex gap-3 pb-5 last:pb-0"
        >
          <span
            aria-hidden="true"
            className={cx(
              "z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
              step.state === "done" && "border-ink bg-ink text-white",
              step.state === "current" && "border-accent bg-accent text-ink",
              step.state === "failed" && "border-danger bg-danger text-white",
              step.state === "next" && "border-2 border-line-strong bg-surface",
            )}
          >
            {step.state === "done" ? "✓" : step.state === "failed" ? "!" : null}
          </span>
          {index < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={cx(
                "absolute left-[11px] top-6 h-[calc(100%-1.5rem)] w-0.5",
                step.state === "done" ? "bg-ink" : "bg-line",
              )}
            />
          )}
          <span className="flex min-w-0 flex-col">
            <span
              className={cx(
                "text-[15px] font-medium text-ink",
                step.state === "next" && "text-muted",
                step.state === "failed" && "text-danger",
              )}
            >
              {step.label}
            </span>
            {step.detail && <span className="text-[13px] text-muted">{step.detail}</span>}
            <span className="sr-only">{stateLabels[step.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
