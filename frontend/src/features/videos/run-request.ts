export type Mode = "review" | "auto";
export type Voice = "original" | "ai";

// Body for POST /videos/{id}/runs: the chosen workspace voice travels as voice_id only for AI voiceover.
export function runRequestBody({
  mode,
  voice,
  voiceId,
}: {
  mode: Mode;
  voice: Voice;
  voiceId: string;
}): { mode: Mode; voice: Voice; voice_id?: string } {
  return voice === "ai" ? { mode, voice, voice_id: voiceId } : { mode, voice };
}
