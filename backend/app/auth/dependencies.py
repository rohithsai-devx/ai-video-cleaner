"""FastAPI dependencies: decode the bearer token, then open tenant_tx for that user."""

from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.security import InvalidTokenError, decode_token
from app.shared.db import Conn, tenant_tx

_bearer = HTTPBearer(auto_error=False)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED, "invalid or expired token", headers={"WWW-Authenticate": "Bearer"}
    )


async def current_user_id(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> UUID:
    if creds is None or creds.scheme.lower() != "bearer":
        raise _unauthorized()
    try:
        return decode_token(creds.credentials)
    except InvalidTokenError:
        raise _unauthorized() from None


CurrentUser = Annotated[UUID, Depends(current_user_id)]


async def tenant_conn(user_id: CurrentUser) -> AsyncIterator[Conn]:
    """The request's single transaction; commits when the endpoint returns, rolls back if it raises."""
    async with tenant_tx(user_id) as conn:
        yield conn


# scope="function": the transaction ends (commits) before the response is sent.
TenantConn = Annotated[Conn, Depends(tenant_conn, scope="function")]
