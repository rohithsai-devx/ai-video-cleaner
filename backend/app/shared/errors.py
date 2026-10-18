"""HTTP error helpers shared by the routers."""

from fastapi import HTTPException, status


def not_found(what: str = "video") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")
