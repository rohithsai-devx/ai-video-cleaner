import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-2xl border border-line bg-surface p-6", className)} {...props} />
  );
}
