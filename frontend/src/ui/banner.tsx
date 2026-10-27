import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type BannerTone = "info" | "success" | "warning" | "danger";
const tones: Record<BannerTone, string> = {
  info: "bg-accent-soft text-ink",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export type BannerProps = HTMLAttributes<HTMLDivElement> & {
  tone: BannerTone;
  action?: ReactNode;
};

export function Banner({ tone, action, className, children, ...props }: BannerProps) {
  return (
    <div
      {...props}
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-4",
        tones[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1 text-sm">{children}</div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}
