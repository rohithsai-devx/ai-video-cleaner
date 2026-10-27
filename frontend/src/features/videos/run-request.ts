import type { components } from "@/api/generated/schema";

export type Mode = "review" | "auto";
export type Voice = "original" | "ai";
export type FixOptions = components["schemas"]["FixOptions"];

export const DEFAULT_FIX_OPTIONS: FixOptions = {
  pauses: true,
  filler: true,
  retakes: true,
  slow_parts: true,
};

// The selected voice travels as voice_id only for AI voiceover.
export function runRequestBody({
  mode,
  voice,
  voiceId,
  fixOptions,
}: {
  mode: Mode;
  voice: Voice;
  voiceId: string;
  fixOptions: FixOptions;
}): { mode: Mode; voice: Voice; voice_id?: string; fix_options: FixOptions } {
  return {
    mode,
    voice,
    ...(voice === "ai" ? { voice_id: voiceId } : {}),
    fix_options: { ...fixOptions },
  };
}
