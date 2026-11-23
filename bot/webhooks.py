"""Outbound webhooks. Events raised by the API are signed and POSTed to the seller's saved endpoints.

Because sellers choose the URLs, every request is made through a resolver that only connects to public
addresses (no loopback, private, link-local or metadata addresses), over https, on standard ports,
without following redirects."""
import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import socket
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from firebase_admin import firestore

from db import db
from util import err, owner_app

log = logging.getLogger("sovyx.webhooks")

EVENTS = {"license.redeemed", "session.started", "login.blocked", "hwid.reset", "key.banned", "keys.created"}
OWNER_EVENTS = {"hwid.reset", "key.banned"}          # events a dashboard may report itself
ATTEMPT_DELAYS = [0, 10, 60, 300, 1800]              # seconds before attempts 1..5
TIMEOUT = 8
ALLOWED_PORTS = {443, 8443}
MAX_PENDING = 500
CONCURRENCY = 10
CACHE_SECONDS = 30
LOG_KEEP = 200
ALLOW_PRIVATE = False                                 # tests only; never enabled by configuration

LOOP: asyncio.AbstractEventLoop | None = None
_sem: asyncio.Semaphore | None = None
_pending = 0
_cache: dict[str, tuple[float, list[dict]]] = {}
_plan_cache: dict[str, tuple[float, bool]] = {}


class Blocked(OSError):
    """The destination isn't a public address."""


def start(loop: asyncio.AbstractEventLoop) -> None:
    global LOOP, _sem
    LOOP, _sem = loop, asyncio.Semaphore(CONCURRENCY)


# ---------- destination safety ----------
def _is_public(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_global or ALLOW_PRIVATE
    except ValueError:
        return False


def check_url(url: str) -> str | None:
    """Returns a reason the URL can't be used, or None if it's fine."""
    try:
        u = urlsplit(url)
        port = u.port or 443
    except ValueError:
        return "That isn't a valid URL."
    if u.scheme != "https" and not (ALLOW_PRIVATE and u.scheme == "http"):
        return "Webhook URLs must start with https://."
    if not u.hostname:
        return "The URL has no host."
    if u.username or u.password:
        return "Remove the username and password from the URL."
    if port not in ALLOWED_PORTS and not ALLOW_PRIVATE:
        return "Use port 443 or 8443."
    try:
        ip = ipaddress.ip_address(u.hostname)
    except ValueError:
        return None                                   # a hostname: checked again when connecting
    return None if _is_public(str(ip)) else "That address isn't public."


class SafeResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_UNSPEC):
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, family=family, type=socket.SOCK_STREAM)
        good = [{"hostname": host, "host": a[0], "port": port, "family": fam, "proto": 0, "flags": socket.AI_NUMERICHOST}
                for fam, _, _, _, a in infos if _is_public(a[0])]
        if not good:
            raise Blocked(f"{host} doesn't point to a public address")
        return good

    async def close(self):
        return None


# ---------- signing + sending ----------
def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


async def _post(url: str, body: bytes, headers: dict) -> tuple[int | None, str | None, bool]:
    """Returns (status, error, worth_retrying)."""
    connector = aiohttp.TCPConnector(resolver=SafeResolver(), use_dns_cache=False, limit=5)
    try:
        async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=TIMEOUT)) as s:
            async with s.post(url, data=body, headers=headers, allow_redirects=False) as r:
                code = r.status
        retry = code >= 500 or code in (408, 429)
        return code, None if 200 <= code < 300 else f"HTTP {code}", retry
    except aiohttp.ClientConnectorError as e:
        return None, str(e.os_error)[:200] if isinstance(e.os_error, Blocked) else "Couldn't connect", not isinstance(e.os_error, Blocked)
    except asyncio.TimeoutError:
        return None, "Timed out", True
    except Exception as e:                            # noqa: BLE001
        return None, f"{type(e).__name__}"[:200], True


def _ensure_secret(app_id: str, hook: dict) -> str:
    secret = hook.get("secret")
    if not secret:
        secret = secrets.token_hex(24)
        try:
            db.collection("apps").document(app_id).collection("webhooks").document(hook["id"]).update({"secret": secret})
        except Exception:                             # noqa: BLE001
            log.warning("couldn't store webhook secret", exc_info=True)
    return secret


def _write_log(app_id: str, entry: dict) -> None:
    try:
        col = db.collection("apps").document(app_id).collection("webhookLog")
        col.add(entry)
        if secrets.randbelow(25) == 0:                # now and then, trim old entries
            old = col.order_by("at", direction=firestore.Query.DESCENDING).offset(LOG_KEEP).limit(100).get()
            for d in old:
                d.reference.delete()
    except Exception:                                 # noqa: BLE001
        log.warning("webhook log write failed", exc_info=True)


async def deliver(app_id: str, hook: dict, event: dict, retries: bool = True) -> dict:
    """Sends one event to one webhook, retrying on failure, and records the outcome."""
    problem = check_url(hook.get("url", ""))
    attempts, code, error = 0, None, problem
    if not problem:
        body = json.dumps(event, separators=(",", ":")).encode()
        secret = hook.get("secret") or await asyncio.to_thread(_ensure_secret, app_id, hook)
        for delay in (ATTEMPT_DELAYS if retries else [0]):
            if delay:
                await asyncio.sleep(delay)
            attempts += 1
            ts = str(int(time.time()))
            headers = {"Content-Type": "application/json", "User-Agent": "Sovyx-Webhooks/1", "X-Sovyx-Event": event["type"],
                       "X-Sovyx-Delivery": event["id"], "X-Sovyx-Timestamp": ts, "X-Sovyx-Signature": sign(secret, ts, body)}
            async with _sem:
                code, error, retry = await _post(hook["url"], body, headers)
            if code and 200 <= code < 300:
                break
            if not retry:
                break
    ok = bool(code and 200 <= code < 300)
    result = {"ok": ok, "status": code, "error": None if ok else (error or "Failed"), "attempts": attempts}
    host = urlsplit(hook.get("url", "")).hostname or ""
    await asyncio.to_thread(_write_log, app_id, {
        "webhookId": hook.get("id"), "host": host, "event": event["type"], "deliveryId": event["id"], "ok": ok, "status": code,
        "error": result["error"], "attempts": attempts, "at": firestore.SERVER_TIMESTAMP})
    return result


# ---------- finding who to notify ----------
def _owner_allowed(app_id: str) -> bool:
    """Webhooks are a Pro feature; check the owner's current plan (cached briefly)."""
    hit = _plan_cache.get(app_id)
    if hit and time.monotonic() - hit[0] < 60:
        return hit[1]
    ok = False
    try:
        app = db.collection("apps").document(app_id).get()
        if app.exists:
            user = db.collection("users").document(app.get("ownerUid")).get().to_dict() or {}
            plan, exp = user.get("plan") or "free", user.get("expiresAt")
            expired = isinstance(exp, datetime) and exp < datetime.now(timezone.utc)
            ok = plan in ("pro", "ultimate") and not expired and not user.get("banned")
    except Exception:                                 # noqa: BLE001
        log.warning("plan check failed", exc_info=True)
    _plan_cache[app_id] = (time.monotonic(), ok)
    return ok


def _hooks(app_id: str, fresh: bool = False) -> list[dict]:
    hit = _cache.get(app_id)
    if hit and not fresh and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    docs = db.collection("apps").document(app_id).collection("webhooks").limit(25).get()
    hooks = [{"id": d.id, **d.to_dict()} for d in docs]
    _cache[app_id] = (time.monotonic(), hooks)
    return hooks


def make_event(app_id: str, type_: str, data: dict) -> dict:
    return {"id": "evt_" + secrets.token_hex(8), "type": type_, "createdAt": datetime.now(timezone.utc).isoformat(), "appId": app_id, "data": data}


async def _run(app_id: str, type_: str, data: dict) -> None:
    hooks = await asyncio.to_thread(_hooks, app_id)
    wanted = [h for h in hooks if type_ in (h.get("events") or [])]
    if not wanted or not await asyncio.to_thread(_owner_allowed, app_id):
        return
    event = make_event(app_id, type_, data)
    await asyncio.gather(*(deliver(app_id, h, event) for h in wanted), return_exceptions=True)


def _finished(task: asyncio.Task) -> None:
    global _pending
    _pending = max(0, _pending - 1)
    if not task.cancelled() and task.exception():
        log.warning("webhook task failed: %r", task.exception())


def _spawn(app_id: str, type_: str, data: dict) -> None:
    global _pending
    if _pending >= MAX_PENDING:
        log.warning("webhook queue full, dropped %s for %s", type_, app_id)
        return
    _pending += 1
    asyncio.create_task(_run(app_id, type_, data)).add_done_callback(_finished)


def emit(app_id: str, type_: str, data: dict) -> None:
    """Raise an event. Safe to call from any thread and from request handlers; never raises or blocks."""
    try:
        if LOOP is not None and type_ in EVENTS and app_id:
            LOOP.call_soon_threadsafe(_spawn, app_id, type_, dict(data))
    except Exception:                                 # noqa: BLE001
        log.warning("couldn't raise webhook event", exc_info=True)


# ---------- HTTP (called by the dashboard) ----------
async def test_hook(request: web.Request) -> web.Response:
    _, app, _ = await owner_app(request)
    app_id, wid = request.match_info["app_id"], request.match_info["wid"]
    snap = await asyncio.to_thread(db.collection("apps").document(app_id).collection("webhooks").document(wid).get)
    if not snap.exists:
        return err(404, "That webhook doesn't exist.")
    hook = {"id": snap.id, **snap.to_dict()}
    event = make_event(app_id, "ping", {"message": "This is a test from your Sovyx dashboard."})
    result = await deliver(app_id, hook, event, retries=False)
    return web.json_response(result)


async def report_event(request: web.Request) -> web.Response:
    """The dashboard reports actions the owner took there (HWID resets, bans) so webhooks hear about them too."""
    _, app, user = await owner_app(request)
    try:
        body = await request.json()
        type_, key = str(body.get("type", "")), str(body.get("key", ""))[:80]
    except Exception:                                 # noqa: BLE001
        return err(400, "Send a JSON body.")
    if type_ not in OWNER_EVENTS or not key:
        return err(400, "Unknown event.")
    emit(request.match_info["app_id"], type_, {"key": key, "by": user.get("email") or "owner"})
    return web.json_response({"ok": True})


ROUTES = [
    web.post("/api/apps/{app_id}/webhooks/{wid}/test", test_hook),
    web.post("/api/apps/{app_id}/events", report_event),
]
