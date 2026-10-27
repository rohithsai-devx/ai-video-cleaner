"""Generate static OpenAI voice previews; requires OPENAI_API_KEY and the ffmpeg CLI."""

import subprocess
from pathlib import Path
from shutil import which

from app.providers.bundle import Call, build
from app.shared.config import VOICES, get_settings

SAMPLE_TEXT = "Here's how to set up a new project in under a minute."
_FFMPEG_ARGS = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    "pipe:0",
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "4",
    "-f",
    "mp3",
    "pipe:1",
]


def main() -> None:
    settings = get_settings()
    if not settings.openai_api_key.get_secret_value():
        raise SystemExit("OPENAI_API_KEY is not configured")
    if which("ffmpeg") is None:
        raise SystemExit("ffmpeg is required to convert the provider's WAV samples to MP3")

    output_dir = Path(__file__).resolve().parents[2] / "frontend" / "public" / "voice-samples"
    output_dir.mkdir(parents=True, exist_ok=True)
    providers = build(settings)
    call = Call(workspace_id="voice-samples", run_id="voice-samples", stage="voice_sample")

    for voice in VOICES:
        clip = providers.synthesize(call, SAMPLE_TEXT, voice["id"])
        result = subprocess.run(_FFMPEG_ARGS, input=clip.audio, capture_output=True, check=True)
        if not result.stdout:
            raise RuntimeError(f"ffmpeg produced an empty sample for {voice['id']}")
        (output_dir / f"{voice['id']}.mp3").write_bytes(result.stdout)
        print(f"wrote {voice['id']}.mp3")


if __name__ == "__main__":
    main()
