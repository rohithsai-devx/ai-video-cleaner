export function formatClock(seconds: number): string {
  const roundedSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatLength(seconds: number): string {
  return formatClock(seconds);
}

export function formatSpan([start, end]: [number, number]): string {
  return `${formatClock(start)} to ${formatClock(end)}`;
}

export function formatShorter(before: number, after: number): string {
  return `${formatClock(Math.max(0, before - after))} shorter`;
}

/** A playback rate for labels: at most one decimal, so a capped 1.7333 reads "1.7". */
export function formatRate(rate: number): string {
  return String(Number(rate.toFixed(1)));
}

/** A short span of seconds for labels, at most one decimal. */
export function formatSeconds(seconds: number): string {
  return String(Number(Math.max(0, seconds).toFixed(1)));
}
