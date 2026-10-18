"""POST /auth/signup, POST /auth/signin and GET /me."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from psycopg import errors

from app.auth.dependencies import CurrentUser
from app.auth.schemas import Me, MeUser, MeWorkspace, SignIn, SignUp, Token
from app.auth.security import hash_password, issue_token, verify_password
from app.shared.db import anon_tx, set_user, tenant_tx

router = APIRouter(tags=["auth"])


def _workspace_name(body: SignUp) -> str:
    base = body.name.strip() if body.name and body.name.strip() else str(body.email).split("@")[0]
    return f"{base[:100]}'s workspace"


@router.post("/auth/signup", status_code=status.HTTP_201_CREATED)
async def signup(body: SignUp) -> Token:
    password_hash = await hash_password(body.password)
    try:
        async with anon_tx() as conn:
            cur = await conn.execute(
                "select app.register_credentials(%s, %s, %s) as uid",
                (str(body.email), body.name, password_hash),
            )
            row = await cur.fetchone()
            assert row is not None
            user_id: UUID = row["uid"]
            await set_user(conn, user_id)
            await conn.execute("select app.create_workspace(%s)", (_workspace_name(body),))
    except errors.UniqueViolation:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered") from None
    return issue_token(user_id)


@router.post("/auth/signin")
async def signin(body: SignIn) -> Token:
    async with anon_tx() as conn:
        cur = await conn.execute(
            "select user_id, password_hash from app.credentials_for(%s)", (str(body.email),)
        )
        row = await cur.fetchone()
    stored = row["password_hash"] if row else None
    if not await verify_password(stored, body.password) or row is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "invalid email or password", headers={"WWW-Authenticate": "Bearer"}
        )
    return issue_token(row["user_id"])


@router.get("/me")
async def me(user_id: CurrentUser) -> Me:
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute("select id, email, name from users where id = app.uid()")
        user = await cur.fetchone()
        cur = await conn.execute(
            "select w.id, w.name, m.role from workspace_members m join workspaces w on w.id = m.workspace_id"
            " where m.user_id = app.uid() order by w.created_at, w.id"
        )
        workspaces = await cur.fetchall()
    if user is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "unknown user", headers={"WWW-Authenticate": "Bearer"}
        )
    return Me(user=MeUser(**user), workspaces=[MeWorkspace(**w) for w in workspaces])
