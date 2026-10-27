import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWaveformPeaks } from "./waveform";

describe("fetchWaveformPeaks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the signed waveform object", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rate: 50, peaks: [0, 0.4, 1] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWaveformPeaks("https://storage.example.test/peaks.json")).resolves.toEqual({
      rate: 50,
      peaks: [0, 0.4, 1],
    });
    expect(fetchMock).toHaveBeenCalledWith("https://storage.example.test/peaks.json", {
      signal: undefined,
    });
  });

  it("rejects unavailable or malformed waveform data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchWaveformPeaks("https://storage.example.test/missing.json")).rejects.toThrow(
      "Waveform request failed",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ rate: 0, peaks: [0.2, "bad"] }),
      }),
    );
    await expect(fetchWaveformPeaks("https://storage.example.test/bad.json")).rejects.toThrow(
      "Waveform data is invalid",
    );
  });
});
