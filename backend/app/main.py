"""FastAPI application."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.auth.router import router as auth_router
from app.runs.router import router as runs_router
from app.shared import db, events
from app.shared.config import get_settings
from app.shares.router import router as shares_router
from app.videos.router import router as videos_router


@asynccontextmanager
async def _fake_worker() -> AsyncIterator[None]:
    """Local dev only: the in-process relay and stages, with fixture engines (FAKE_WORKER=true)."""
    from app.pipeline.fixture_engines import FixtureEngines
    from app.pipeline.relay import run_in_process
    from app.shared.storage import get_storage  # imported lazily: never loaded in production

    s = get_settings()
    if not s.database_url_worker:
        raise RuntimeError("FAKE_WORKER needs DATABASE_URL_WORKER")
    storage = get_storage()
    await db.open_worker_pool(s.database_url_worker)
    stop = asyncio.Event()
    task = asyncio.create_task(run_in_process(stop, FixtureEngines(storage), storage))
    try:
        yield
    finally:
        stop.set()
        try:
            await asyncio.wait_for(task, timeout=10)
        except TimeoutError:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await db.close_worker_pool()


def create_app(*, manage_pool: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if not manage_pool:
            yield
            return
        s = get_settings()
        await db.open_pool(s.database_url_api, min_size=s.db_pool_min_size, max_size=s.db_pool_max_size)
        try:
            async with contextlib.AsyncExitStack() as stack:
                if s.fake_worker:
                    await stack.enter_async_context(_fake_worker())
                yield
        finally:
            await events.close_redis()
            await db.close_pool()

    app = FastAPI(title="AI Video Cleaner API", version="0.1.0", lifespan=lifespan)
    for r in (auth_router, videos_router, runs_router, shares_router):
        app.include_router(r)
    _sse_only_openapi(app)
    return app


def _sse_only_openapi(app: FastAPI) -> None:
    """FastAPI documents a response model as application/json; the events route is text/event-stream only."""
    base = app.openapi

    def openapi() -> dict[str, object]:
        if app.openapi_schema is None:
            spec = base()
            for path, item in spec.get("paths", {}).items():
                if path.endswith("/events"):
                    item["get"]["responses"]["200"]["content"].pop("application/json", None)
        return app.openapi_schema  # type: ignore[return-value]

    app.openapi = openapi  # type: ignore[method-assign]


app = create_app()
