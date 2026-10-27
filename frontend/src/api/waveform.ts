export type WaveformPeaks = { rate: number; peaks: number[] };

export async function fetchWaveformPeaks(
  url: string,
  signal?: AbortSignal,
): Promise<WaveformPeaks> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Waveform request failed");

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("Waveform data is invalid");
  const { rate, peaks } = payload as { rate?: unknown; peaks?: unknown };
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Array.isArray(peaks) ||
    !peaks.every(
      (peak): peak is number =>
        typeof peak === "number" && Number.isFinite(peak) && peak >= 0 && peak <= 1,
    )
  ) {
    throw new Error("Waveform data is invalid");
  }
  return { rate, peaks };
}
