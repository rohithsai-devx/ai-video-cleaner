"""Password hashing (argon2) and HS256 access tokens. Hashes never leave app.auth."""

import asyncio
import time
from uuid import UUID

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.auth.schemas import Token
from app.shared.config import get_settings

_hasher = PasswordHasher()
# Verified against when the email is unknown, so a miss costs the same time as a wrong password.
_DUMMY_HASH = _hasher.hash("not-a-real-password")


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(_hasher.hash, password)


def _verify(stored_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


async def verify_password(stored_hash: str | None, password: str) -> bool:
    return await asyncio.to_thread(_verify, stored_hash, password)


_ALG = "HS256"


class InvalidTokenError(Exception):
    pass


def issue_token(user_id: UUID, *, ttl_seconds: int | None = None) -> Token:
    settings = get_settings()
    ttl = settings.jwt_ttl_seconds if ttl_seconds is None else ttl_seconds
    now = int(time.time())
    claims = {"sub": str(user_id), "iat": now, "exp": now + ttl}
    token = jwt.encode(claims, settings.jwt_secret.get_secret_value(), algorithm=_ALG)
    return Token(access_token=token, expires_in=max(ttl, 1))


def decode_token(token: str) -> UUID:
    """Return the user id, or raise InvalidTokenError for a bad, forged or expired token."""
    try:
        claims = jwt.decode(
            token,
            get_settings().jwt_secret.get_secret_value(),
            algorithms=[_ALG],
            options={"require": ["exp", "sub"]},
        )
        return UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError, TypeError) as e:
        raise InvalidTokenError(str(e)) from e
