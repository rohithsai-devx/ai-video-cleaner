"""Sign-up, sign-in and token models."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.contracts.enums import MemberRole


class SignUp(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    name: str | None = Field(default=None, max_length=200)


class SignIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class Token(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = Field(ge=1)


class MeUser(BaseModel):
    id: UUID
    email: EmailStr
    name: str | None


class MeWorkspace(BaseModel):
    id: UUID
    name: str
    role: MemberRole


class Me(BaseModel):
    user: MeUser
    workspaces: list[MeWorkspace]
