import type { HTMLAttributes } from "react";
import { cx } from "./cx";

// Loading placeholder: a pulsing block, never a spinner.
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cx("animate-pulse rounded-xl motion-reduce:animate-none bg-sunken", className)}
      {...props}
    />
  );
}
