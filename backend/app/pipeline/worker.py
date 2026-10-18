import asyncio

from app.pipeline.media_engines import MediaEngines
from app.pipeline.relay import run_in_process
from app.shared import db
from app.shared.config import get_settings
from app.shared.storage import get_storage


async def _main() -> None:
    settings = get_settings()
    if not settings.database_url_worker:
        raise RuntimeError("the media worker needs DATABASE_URL_WORKER")
    storage = get_storage()
    await db.open_worker_pool(settings.database_url_worker)
    stop = asyncio.Event()
    try:
        await run_in_process(stop, MediaEngines(storage), storage)
    finally:
        await db.close_worker_pool()


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
