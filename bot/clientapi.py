"""Endpoints a seller's own software calls: sign in with a key (locks it to the device and opens a session),
heartbeat, sign out, and buyer self-service HWID resets."""
import asyncio
import hashlib
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from aiohttp import web
from firebase_admin import firestore

from db import db
from util import client_ip, err, plog
from webhooks import emit

LIMIT, WINDOW = 30, 300
HEARTBEAT_SECONDS = 30
_hits: dict[str, deque] = defaultdict(deque)
ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


def _limited(ip: str) -> bool:
    q, now = _hits[ip], time.monotonic()
    while q and now - q[0] > WINDOW:
        q.popleft()
    if len(q) >= LIMIT:
        return True
    q.append(now)
    return False


async def _body(request: web.Request) -> dict:
    try:
        d = await request.json()
    except Exception:
        d = None
    if not isinstance(d, dict):
        raise web.HTTPBadRequest(text="Send a JSON body.")
    return d


def _s(d: dict, key: str, max_len: int) -> str:
    return str(d.get(key, "")).strip()[:max_len]


def _find_license(app_ref, key: str):
    docs = app_ref.collection("licenses").where("key", "==", key).limit(1).get()
    return docs[0] if docs else None


def _license_problem(lic: dict) -> str | None:
    if lic.get("status") == "banned":
        return "This key has been banned."
    exp = lic.get("expiresAt")
    if isinstance(exp, datetime) and exp < datetime.now(timezone.utc):
        return "This key has expired."
    return None


def _masked(key: str) -> str:
    return f"{key[:4]}…{key[-4:]}" if len(key) > 9 else key


def _login(app_id: str, key: str, hwid: str, ip: str, version: str) -> dict:
    app_ref = db.collection("apps").document(app_id)
    app = app_ref.get()
    if not app.exists:
        return {"error": (404, "Unknown application.")}
    ad = app.to_dict()
    site = db.collection("settings").document("site").get()
    if site.exists and site.get("maintenance"):
        return {"error": (503, "Down for maintenance. Try again soon.")}
    blacklist = app_ref.collection("blacklist")
    for value in (ip, hwid):
        if blacklist.where("value", "==", value).limit(1).get():
            emit(app_id, "login.blocked", {"reason": "blacklisted", "ip": ip, "hwid": hwid, "key": key})
            return {"error": (403, "Access denied.")}
    snap = _find_license(app_ref, key)
    if not snap:
        return {"error": (401, "That key isn't valid.")}
    ref, lic = snap.reference, snap.to_dict()
    if (problem := _license_problem(lic)):
        emit(app_id, "login.blocked", {"reason": "banned" if "banned" in problem else "expired", "key": key, "ip": ip, "hwid": hwid})
        return {"error": (403, problem)}

    now, update, expires = datetime.now(timezone.utc), {}, lic.get("expiresAt")
    if lic.get("status", "unused") == "unused":
        days = int(lic.get("days") or 0)
        expires = None if days == 0 else now + timedelta(days=days)
        update.update(status="used", usedBy=lic.get("usedBy") or "software login", activatedAt=firestore.SERVER_TIMESTAMP, expiresAt=expires)
        plog(app_id, f"Key {key} activated by its first login", "buyer", "redeem")
        emit(app_id, "license.redeemed", {"key": key, "via": "login", "ip": ip, "days": days})

    bound, locked = lic.get("hwid"), ad.get("hwidLock") is not False
    if locked and bound and bound != hwid:
        plog(app_id, f"Blocked a login for {key}: different device", "buyer", "blocked")
        emit(app_id, "login.blocked", {"reason": "hwid_mismatch", "key": key, "ip": ip, "hwid": hwid})
        return {"error": (403, "This key is locked to another device. Ask for an HWID reset.")}
    if not bound:
        update["hwid"] = hwid
        plog(app_id, f"Locked {key} to a device", "buyer", "hwid")
    update.update(lastLoginAt=firestore.SERVER_TIMESTAMP, lastIp=ip)
    if version:
        update["lastVersion"] = version
    ref.update(update)

    token = secrets.token_urlsafe(24)
    app_ref.collection("sessions").document(snap.id).set({
        "username": _masked(key), "ip": ip, "hwid": hwid, "licenseId": snap.id, "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
        "startedAt": firestore.SERVER_TIMESTAMP, "lastSeen": firestore.SERVER_TIMESTAMP, "version": version,
    })
    emit(app_id, "session.started", {"key": key, "ip": ip, "hwid": hwid, "version": version or None})
    variables = {}
    for v in app_ref.collection("variables").limit(100).get():
        d = v.to_dict()
        if d.get("name"):
            variables[d["name"]] = d.get("value", "")
    return {"ok": {
        "session": token, "heartbeatSeconds": HEARTBEAT_SECONDS,
        "expiresAt": expires.isoformat() if isinstance(expires, datetime) else None,
        "daysLeft": max(0, (expires - now).days) if isinstance(expires, datetime) else None,
        "variables": variables,
    }}


def _find_session(app_ref, token: str):
    docs = app_ref.collection("sessions").where("tokenHash", "==", hashlib.sha256(token.encode()).hexdigest()).limit(1).get()
    return docs[0] if docs else None


def _heartbeat(app_id: str, token: str) -> dict:
    app_ref = db.collection("apps").document(app_id)
    sess = _find_session(app_ref, token)
    if not sess:
        return {"error": (401, "Session ended. Sign in again.")}
    lic = app_ref.collection("licenses").document(sess.to_dict().get("licenseId", "-")).get()
    problem = "This key was removed." if not lic.exists else _license_problem(lic.to_dict())
    if problem:
        sess.reference.delete()
        return {"error": (403, problem)}
    sess.reference.update({"lastSeen": firestore.SERVER_TIMESTAMP})
    return {"ok": {"ok": True}}


def _logout(app_id: str, token: str) -> dict:
    sess = _find_session(db.collection("apps").document(app_id), token)
    if sess:
        sess.reference.delete()
    return {"ok": {"ok": True}}


def _wait_text(delta: timedelta) -> str:
    hours_total = max(1, -(-int(delta.total_seconds()) // 3600))  # round up to whole hours
    days, hours = divmod(hours_total, 24)
    if days:
        return f"{days} day{'s' if days != 1 else ''}" + (f" {hours} hour{'s' if hours != 1 else ''}" if hours else "")
    return f"{hours} hour{'s' if hours != 1 else ''}"


def reset_hwid(app_id: str, key: str) -> dict:
    """Buyer self-service reset, limited by the seller's setting (on/off and cooldown)."""
    app_ref = db.collection("apps").document(app_id)
    app = app_ref.get()
    if not app.exists:
        return {"error": (404, "Unknown application.")}
    cfg = app.to_dict().get("hwidReset") or {}
    if cfg.get("enabled") is False:
        return {"error": (403, "HWID resets for this product go through support.")}
    snap = _find_license(app_ref, key)
    if not snap:
        return {"error": (401, "That key isn't valid.")}
    ref, lic = snap.reference, snap.to_dict()
    if lic.get("status") == "banned":
        return {"error": (403, "This key has been banned.")}
    if not lic.get("hwid"):
        return {"error": (409, "Nothing to reset. This key isn't locked to a device yet.")}
    cooldown, last = int(cfg.get("cooldownDays", 7) or 0), lic.get("lastHwidReset")
    if cooldown and isinstance(last, datetime):
        wait = last + timedelta(days=cooldown) - datetime.now(timezone.utc)
        if wait > timedelta(0):
            return {"error": (429, f"You can reset again in {_wait_text(wait)}.")}
    ref.update({"hwid": None, "lastHwidReset": firestore.SERVER_TIMESTAMP, "hwidResets": firestore.Increment(1)})
    app_ref.collection("sessions").document(snap.id).delete()
    plog(app_id, f"Buyer reset the HWID of {key}", "buyer", "hwid")
    emit(app_id, "hwid.reset", {"key": key, "by": "buyer"})
    return {"ok": {"ok": True, "cooldownDays": cooldown}}


# ---------- HTTP ----------
async def _run(fn, *args) -> web.Response:
    result = await asyncio.to_thread(fn, *args)
    return err(*result["error"]) if "error" in result else web.json_response(result["ok"])


def _app_id(d: dict) -> str:
    app_id = _s(d, "appId", 64)
    if not ID.fullmatch(app_id):
        raise web.HTTPBadRequest(text="Missing or invalid appId.")
    return app_id


def _key(d: dict) -> str:
    key = _s(d, "key", 80).upper()
    if not 4 <= len(key) <= 80:
        raise web.HTTPBadRequest(text="Enter the product key.")
    return key


async def login(request: web.Request) -> web.Response:
    ip = client_ip(request)
    if _limited(ip):
        return err(429, "Too many attempts. Wait a few minutes.")
    d = await _body(request)
    hwid = _s(d, "hwid", 200)
    if len(hwid) < 8:
        raise web.HTTPBadRequest(text="Send the device's hwid (at least 8 characters).")
    return await _run(_login, _app_id(d), _key(d), hwid, ip, _s(d, "version", 24))


async def heartbeat(request: web.Request) -> web.Response:
    d = await _body(request)
    token = _s(d, "session", 80)
    if len(token) < 20:
        raise web.HTTPBadRequest(text="Missing session.")
    return await _run(_heartbeat, _app_id(d), token)


async def logout(request: web.Request) -> web.Response:
    d = await _body(request)
    token = _s(d, "session", 80)
    if len(token) < 20:
        raise web.HTTPBadRequest(text="Missing session.")
    return await _run(_logout, _app_id(d), token)


async def hwid_reset(request: web.Request) -> web.Response:
    if _limited(client_ip(request)):
        return err(429, "Too many attempts. Wait a few minutes.")
    d = await _body(request)
    return await _run(reset_hwid, _app_id(d), _key(d))


async def hwid_reset_for_page(request: web.Request) -> web.Response:
    """Same reset, called from a seller's customer page (sovyx.cc/b/<slug>)."""
    if _limited(client_ip(request)):
        return err(429, "Too many attempts. Wait a few minutes.")
    d = await _body(request)
    brand = await asyncio.to_thread(db.collection("brands").document(request.match_info["slug"].lower()).get)
    if not brand.exists:
        return err(404, "This page doesn't exist.")
    return await _run(reset_hwid, brand.get("appId"), _key(d))


ROUTES = [
    web.post("/api/v1/login", login),
    web.post("/api/v1/heartbeat", heartbeat),
    web.post("/api/v1/logout", logout),
    web.post("/api/v1/hwid-reset", hwid_reset),
    web.post("/api/b/{slug}/hwid-reset", hwid_reset_for_page),
]
