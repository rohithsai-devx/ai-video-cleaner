import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & { action?: ReactNode };

export function EmptyState({ action, className, children, ...props }: EmptyStateProps) {
  return (
    <div
      {...props}
      className={cx("flex flex-col items-center justify-center gap-3 py-8 text-center", className)}
    >
      <p className="text-sm text-muted">{children}</p>
      {action}
    </div>
  );
}
