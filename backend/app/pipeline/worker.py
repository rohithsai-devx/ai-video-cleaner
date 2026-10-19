import asyncio

from app.pipeline.media_engines import MediaEngines
from app.pipeline.relay import run_in_process
from app.providers.bundle import build
from app.shared import db
from app.shared.config import get_settings
from app.shared.storage import get_storage

# ffmpeg stages. This process is the Docker worker. It never claims ``agent``, so it never loads Laya.
FFMPEG_QUEUES = ("pre-cpu", "post-io")
# The yes/no model loads on the Mac. See mac_agent.py.
AGENT_QUEUES = ("agent",)


async def serve(queues: tuple[str, ...]) -> None:
    settings = get_settings()
    if not settings.database_url_worker:
        raise RuntimeError("the media worker needs DATABASE_URL_WORKER")
    storage = get_storage()
    await db.open_worker_pool(settings.database_url_worker)
    stop = asyncio.Event()
    try:
        # The bundle is HTTP for chat, vision, and speech. Laya imports only when yes_no runs,
        # which is the agent queue, and this default process does not claim that queue.
        await run_in_process(
            stop, MediaEngines(storage, build(settings, frame_reader=storage.download_bytes)), storage, queues
        )
    finally:
        await db.close_worker_pool()


def main() -> None:
    asyncio.run(serve(FFMPEG_QUEUES))


if __name__ == "__main__":
    main()
