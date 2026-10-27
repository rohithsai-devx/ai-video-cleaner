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
