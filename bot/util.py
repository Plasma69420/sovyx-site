"""Small helpers shared by the HTTP API modules."""
import ipaddress
import logging

from aiohttp import web
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
