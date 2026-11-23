"""Small helpers shared by the HTTP API modules."""
import asyncio
import ipaddress
import logging

from aiohttp import web
from firebase_admin import auth as fb_auth
from firebase_admin import firestore

from db import db

log = logging.getLogger("sovyx.util")


def err(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


def client_ip(request: web.Request) -> str:
    """The caller's real address. Behind Railway's proxies, trust the right-most public address in
    X-Forwarded-For (anything a client adds sits on the left), preferring X-Real-IP when it is public."""
    def public(v: str) -> bool:
        try:
            return ipaddress.ip_address(v.strip()).is_global
        except ValueError:
            return False

    real = request.headers.get("X-Real-IP", "")
    if public(real):
        return real.strip()
    for part in reversed(request.headers.get("X-Forwarded-For", "").split(",")):
        if public(part):
            return part.strip()
    return request.remote or "?"


def plog(app_id: str, text: str, by: str, kind: str = "panel") -> None:
    """Add an entry to a product's activity log. Never raises, so a logging problem can't break a request."""
    try:
        db.collection("productLog").add({"appId": app_id, "type": kind, "text": text, "by": by, "at": firestore.SERVER_TIMESTAMP})
    except Exception:
        log.warning("activity log write failed", exc_info=True)


async def owner_app(request: web.Request) -> tuple[str, dict, dict]:
    """Verify the Firebase ID token and that the caller owns the app. Returns (uid, app, user)."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise web.HTTPUnauthorized(text="sign in required")
    try:
        decoded = await asyncio.to_thread(fb_auth.verify_id_token, header[7:])
    except Exception:
        raise web.HTTPUnauthorized(text="invalid session, sign in again")
    uid, app_id = decoded["uid"], request.match_info["app_id"]
    snap = await asyncio.to_thread(db.collection("apps").document(app_id).get)
    if not snap.exists or snap.get("ownerUid") != uid:
        raise web.HTTPForbidden(text="not your application")
    user = (await asyncio.to_thread(db.collection("users").document(uid).get)).to_dict() or {}
    if user.get("banned"):
        raise web.HTTPForbidden(text="account suspended")
    return uid, snap.to_dict(), user
