"""Shared fixtures: one app_api pool for the whole session, against the compose Postgres (backend/.env)."""

from collections.abc import AsyncIterator

import httpx
import pytest

from app.main import create_app
from app.shared import db
from app.shared.config import get_settings


@pytest.fixture(scope="session", autouse=True)
async def pool() -> AsyncIterator[None]:
    # One connection, so consecutive transactions provably reuse the same backend (identity-leak test).
    await db.open_pool(get_settings().database_url_api, min_size=1, max_size=1)
    yield
    await db.close_pool()


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=create_app(manage_pool=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
