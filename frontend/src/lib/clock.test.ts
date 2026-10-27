import { describe, expect, it } from "vitest";
import { formatClock, formatLength, formatShorter, formatSpan } from "./clock";

describe("clock formatting", () => {
  it("rounds seconds and uses hours-free minutes through the recording limit", () => {
    expect(formatClock(59.4)).toBe("0:59");
    expect(formatClock(59.5)).toBe("1:00");
    expect(formatClock(900)).toBe("15:00");
    expect(formatClock(3600)).toBe("60:00");
    expect(formatLength(127)).toBe("2:07");
  });

  it("formats spans and time saved", () => {
    expect(formatSpan([42, 46])).toBe("0:42 to 0:46");
    expect(formatShorter(127, 0)).toBe("2:07 shorter");
    expect(formatShorter(42, 46)).toBe("0:00 shorter");
  });
});
