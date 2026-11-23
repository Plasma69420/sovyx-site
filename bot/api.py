"""HTTP API served next to the bot: loader uploads (app owners) and key-gated one-time downloads (buyers)."""
import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

from aiohttp import web
from firebase_admin import auth as fb_auth
from firebase_admin import firestore

from clientapi import ROUTES as CLIENT_ROUTES
from db import db
from util import client_ip, err, plog as _plog

log = logging.getLogger("sovyx.api")

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
ALLOWED_ORIGINS = {o.strip() for o in os.getenv("ALLOWED_ORIGINS", "https://sovyx.cc,http://localhost:8080,http://localhost:3456").split(",") if o.strip()}
MAX_BYTES = {"free": 50 * 1024 ** 2, "basic": 250 * 1024 ** 2, "pro": 250 * 1024 ** 2, "ultimate": 250 * 1024 ** 2}
TOKEN_TTL = 300
REDEEM_LIMIT, REDEEM_WINDOW = 10, 300

TOKENS: dict[str, tuple[Path, str, float]] = {}
ATTEMPTS: dict[str, deque] = defaultdict(deque)


def loader_dir(app_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", app_id):
        raise web.HTTPBadRequest(text="bad app id")
    return DATA_DIR / "loaders" / app_id


def effective_plan(user: dict) -> str:
    plan = user.get("plan") or "free"
    exp = user.get("expiresAt")
    if plan != "free" and isinstance(exp, datetime) and exp < datetime.now(timezone.utc):
        return "free"
    return plan if plan in MAX_BYTES else "free"


@web.middleware
async def cors(request: web.Request, handler):
    origin = request.headers.get("Origin", "")
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = web.json_response({"error": e.text if e.text and not e.text.startswith(str(e.status)) else e.reason}, status=e.status)
    if origin in ALLOWED_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


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


async def upload_loader(request: web.Request) -> web.Response:
    _, app, user = await owner_app(request)
    app_id = request.match_info["app_id"]
    limit = MAX_BYTES[effective_plan(user)]
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "file":
        field = await reader.next()
    if field is None or not field.filename:
        return err(400, "No file received.")
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(unquote(field.filename)).name)[:120] or "loader.exe"
    folder = loader_dir(app_id)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "upload.tmp"
    sha, size = hashlib.sha256(), 0
    with tmp.open("wb") as f:
        while chunk := await field.read_chunk(1024 * 1024):
            size += len(chunk)
            if size > limit:
                f.close()
                tmp.unlink(missing_ok=True)
                return err(413, f"File is too large for your plan (max {limit // 1024 ** 2} MB).")
            sha.update(chunk)
            f.write(chunk)
    if size == 0:
        tmp.unlink(missing_ok=True)
        return err(400, "The file is empty.")
    os.replace(tmp, folder / "loader.bin")
    meta = {"name": name, "size": size, "sha256": sha.hexdigest(), "uploadedAt": datetime.now(timezone.utc).isoformat()}
    (folder / "meta.json").write_text(json.dumps(meta))
    await asyncio.to_thread(db.collection("apps").document(app_id).update, {"loader": {**meta, "uploadedAt": firestore.SERVER_TIMESTAMP}})
    if app.get("brandSlug"):
        await asyncio.to_thread(db.collection("brands").document(app["brandSlug"]).set, {"hasLoader": True}, merge=True)
    log.info("Loader uploaded for %s (%d bytes)", app_id, size)
    return web.json_response(meta)


async def delete_loader(request: web.Request) -> web.Response:
    _, app, _ = await owner_app(request)
    app_id = request.match_info["app_id"]
    folder = loader_dir(app_id)
    for f in ("loader.bin", "meta.json"):
        (folder / f).unlink(missing_ok=True)
    await asyncio.to_thread(db.collection("apps").document(app_id).update, {"loader": firestore.DELETE_FIELD})
    if app.get("brandSlug"):
        await asyncio.to_thread(db.collection("brands").document(app["brandSlug"]).set, {"hasLoader": False}, merge=True)
    return web.json_response({"ok": True})


PANEL_DAYS = {0, 1, 7, 30, 90, 365}
KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _kblock() -> str:
    return "".join(secrets.choice(KEY_ALPHABET) for _ in range(4))


async def panel_context(request: web.Request) -> tuple[str, str, dict, str]:
    """Verify the caller and that the panel grant (panelAccess doc) is theirs. Returns (uid, email, grant, grant_id)."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise web.HTTPUnauthorized(text="sign in required")
    try:
        decoded = await asyncio.to_thread(fb_auth.verify_id_token, header[7:])
    except Exception:
        raise web.HTTPUnauthorized(text="invalid session, sign in again")
    grant_id = request.match_info["grant_id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", grant_id):
        raise web.HTTPBadRequest(text="bad panel id")
    snap = await asyncio.to_thread(db.collection("panelAccess").document(grant_id).get)
    if not snap.exists or snap.get("uid") != decoded["uid"]:
        raise web.HTTPForbidden(text="That panel isn't yours.")
    user = (await asyncio.to_thread(db.collection("users").document(decoded["uid"]).get)).to_dict() or {}
    if user.get("banned"):
        raise web.HTTPForbidden(text="account suspended")
    return decoded["uid"], user.get("email") or decoded.get("email", ""), snap.to_dict(), grant_id


def _grant_problem(grant: dict) -> str | None:
    if grant.get("status", "active") != "active":
        return "This panel is suspended."
    exp = grant.get("expiresAt")
    if isinstance(exp, datetime) and exp < datetime.now(timezone.utc):
        return "This panel has expired."
    return None


def _panel_generate(grant_id: str, uid: str, email: str, days: int, qty: int, note: str) -> dict:
    grant_ref = db.collection("panelAccess").document(grant_id)

    @firestore.transactional
    def run(tx):
        g = grant_ref.get(transaction=tx)
        if not g.exists or g.get("uid") != uid:
            return {"error": (403, "That panel isn't yours.")}
        grant = g.to_dict()
        if not grant.get("canGenerate", True):
            return {"error": (403, "Your access doesn't include generating keys.")}
        if (problem := _grant_problem(grant)):
            return {"error": (403, problem)}
        p = db.collection("products").document(grant["productId"]).get(transaction=tx)
        prod = p.to_dict() if p.exists else None
        if not prod or prod.get("active") is False:
            return {"error": (403, "This product is switched off.")}
        cost = (prod.get("costs") or {}).get(str(days))
        if not isinstance(cost, (int, float)) or cost <= 0:
            return {"error": (400, "That duration isn't available for this product.")}
        app_id = prod.get("appId")
        if not app_id:
            return {"error": (503, "This product isn't set up for keys yet. Contact the owner.")}
        total, credits = int(cost) * qty, int(grant.get("credits") or 0)
        if credits < total:
            return {"error": (402, f"Not enough credits: this needs {total}, you have {credits}.")}
        prefix = re.sub(r"[^A-Z0-9]", "", str(prod.get("prefix") or "KEY").upper())[:8] or "KEY"
        lic = db.collection("apps").document(app_id).collection("licenses")
        keys = []
        for _ in range(qty):
            key = f"{prefix}-{_kblock()}-{_kblock()}-{_kblock()}"
            keys.append(key)
            tx.set(lic.document(), {"key": key, "days": days, "note": note, "status": "unused", "usedBy": None, "hwid": None,
                                    "grantId": grant_id, "reseller": email, "productId": grant["productId"],
                                    "createdAt": firestore.SERVER_TIMESTAMP})
        tx.set(db.collection("productLog").document(), {"appId": app_id, "type": "keys", "by": email, "at": firestore.SERVER_TIMESTAMP,
                                                         "text": f"Made {qty} x {days or 'lifetime'}{'d' if days else ''} key{'s' if qty > 1 else ''} ({total} credits)"})
        tx.update(grant_ref, {"credits": credits - total, "keysMade": firestore.Increment(qty), "lastKeyAt": firestore.SERVER_TIMESTAMP})
        tx.set(db.collection("activity").document(), {"action": "Panel keys", "details": f"{qty} x {days or 'lifetime'}{'d' if days else ''} {prod.get('name', '')} for {total} credits",
                                                     "admin": email, "at": firestore.SERVER_TIMESTAMP})
        return {"keys": keys, "credits": credits - total, "cost": total, "appId": app_id}

    return run(db.transaction())


async def panel_generate(request: web.Request) -> web.Response:
    uid, email, _, grant_id = await panel_context(request)
    try:
        body = await request.json()
        days, qty = int(body.get("days")), int(body.get("qty", 1))
    except Exception:
        return err(400, "Pick a duration and amount.")
    note = str(body.get("note", ""))[:80]
    if days not in PANEL_DAYS or not 1 <= qty <= 50:
        return err(400, "Pick a valid duration and an amount from 1 to 50.")
    result = await asyncio.to_thread(_panel_generate, grant_id, uid, email, days, qty, note)
    if "error" in result:
        return err(*result["error"])
    app = await asyncio.to_thread(db.collection("apps").document(result["appId"]).get)
    return web.json_response({"keys": result["keys"], "credits": result["credits"], "cost": result["cost"],
                              "page": (app.to_dict() or {}).get("brandSlug") if app.exists else None})


def _iso(v) -> str | None:
    return v.isoformat() if isinstance(v, datetime) else None


async def panel_scope(request: web.Request, need: str, active: bool = True):
    """Verify the caller owns this panel, that it's allowed to do `need`, and the product is available.
    Returns (uid, email, grant, grant_id, app_id, product)."""
    uid, email, grant, grant_id = await panel_context(request)
    if active and (problem := _grant_problem(grant)):
        raise web.HTTPForbidden(text=problem)
    allowed = {
        "generate": grant.get("canGenerate", True),
        "manage": grant.get("canManage", False),
        "sessions": grant.get("canSessions", False),
        "activity": grant.get("canActivity", False),
        "keys": grant.get("canGenerate", True) or grant.get("canManage", False),
    }[need]
    if not allowed:
        raise web.HTTPForbidden(text="Your access doesn't include this.")
    snap = await asyncio.to_thread(db.collection("products").document(grant["productId"]).get)
    pd = snap.to_dict() if snap.exists else None
    if not pd or pd.get("active") is False or not pd.get("appId"):
        raise web.HTTPServiceUnavailable(text="This product isn't available yet.")
    return uid, email, grant, grant_id, pd["appId"], pd


async def panel_keys(request: web.Request) -> web.Response:
    _, _, grant, grant_id, app_id, _ = await panel_scope(request, "keys", active=False)
    col = db.collection("apps").document(app_id).collection("licenses")
    query = col.limit(500) if grant.get("keyScope") == "all" else col.where("grantId", "==", grant_id).limit(300)
    docs = await asyncio.to_thread(query.get)
    rows = []
    for d in docs:
        x = d.to_dict()
        hw = x.get("hwid")
        rows.append({"id": d.id, "key": x.get("key"), "days": x.get("days"), "status": x.get("status"), "usedBy": x.get("usedBy"), "note": x.get("note", ""),
                     "hwid": (hw[:18] + "…") if hw else None, "reseller": x.get("reseller"), "mine": x.get("grantId") == grant_id, "createdAt": _iso(x.get("createdAt"))})
    rows.sort(key=lambda r: r["createdAt"] or "", reverse=True)
    app = await asyncio.to_thread(db.collection("apps").document(app_id).get)
    return web.json_response({"keys": rows, "page": (app.to_dict() or {}).get("brandSlug") if app.exists else None})


async def panel_key_action(request: web.Request) -> web.Response:
    _, email, grant, grant_id, app_id, _ = await panel_scope(request, "manage")
    lic_id, action = request.match_info["lic_id"], request.match_info["action"]
    if action not in ("reset-hwid", "ban", "unban") or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", lic_id):
        raise web.HTTPNotFound(text="Unknown action.")
    ref = db.collection("apps").document(app_id).collection("licenses").document(lic_id)
    snap = await asyncio.to_thread(ref.get)
    if not snap.exists:
        return err(404, "That key doesn't exist.")
    lic = snap.to_dict()
    if grant.get("keyScope") != "all" and lic.get("grantId") != grant_id:
        return err(403, "That key isn't yours.")
    if action == "reset-hwid":
        update, text = {"hwid": None}, f"Reset HWID of {lic['key']}"
    elif action == "ban":
        update, text = {"status": "banned"}, f"Banned {lic['key']}"
    else:
        update, text = {"status": "used" if lic.get("usedBy") else "unused"}, f"Unbanned {lic['key']}"
    await asyncio.to_thread(ref.update, update)
    await asyncio.to_thread(_plog, app_id, text, email, "key")
    return web.json_response({"ok": True, **update})


async def panel_sessions(request: web.Request) -> web.Response:
    _, _, _, _, app_id, _ = await panel_scope(request, "sessions")
    docs = await asyncio.to_thread(db.collection("apps").document(app_id).collection("sessions").limit(200).get)
    rows = []
    for d in docs:
        x = d.to_dict()
        hw = x.get("hwid")
        rows.append({"id": d.id, "username": x.get("username"), "ip": x.get("ip"), "hwid": (hw[:22] + "…") if hw else None,
                     "lastSeen": _iso(x.get("lastSeen")), "startedAt": _iso(x.get("startedAt"))})
    rows.sort(key=lambda r: r["lastSeen"] or "", reverse=True)
    return web.json_response({"sessions": rows})


async def panel_session_end(request: web.Request) -> web.Response:
    _, email, _, _, app_id, _ = await panel_scope(request, "manage")
    sid = request.match_info["sid"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid):
        raise web.HTTPNotFound(text="Unknown session.")
    await asyncio.to_thread(db.collection("apps").document(app_id).collection("sessions").document(sid).delete)
    await asyncio.to_thread(_plog, app_id, f"Ended session {sid[:8]}", email, "session")
    return web.json_response({"ok": True})


async def panel_activity(request: web.Request) -> web.Response:
    _, _, _, _, app_id, _ = await panel_scope(request, "activity")
    docs = await asyncio.to_thread(db.collection("productLog").where("appId", "==", app_id).limit(300).get)
    rows = [{"type": d.get("type"), "text": d.get("text"), "by": d.get("by"), "at": _iso(d.get("at"))} for d in docs]
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    return web.json_response({"events": rows[:150]})


async def panel_download(request: web.Request) -> web.Response:
    _, _, grant, _ = await panel_context(request)
    if not grant.get("canDownload", True):
        return err(403, "Your access doesn't include downloads.")
    if (problem := _grant_problem(grant)):
        return err(403, problem)
    prod = await asyncio.to_thread(db.collection("products").document(grant["productId"]).get)
    pd = prod.to_dict() if prod.exists else None
    if not pd or pd.get("active") is False or not pd.get("appId"):
        return err(503, "This product isn't available yet.")
    folder = loader_dir(pd["appId"])
    if not (folder / "loader.bin").exists():
        return err(503, "No download has been uploaded for this product yet.")
    meta = json.loads((folder / "meta.json").read_text())
    token = secrets.token_urlsafe(24)
    TOKENS[token] = (folder / "loader.bin", meta["name"], time.time() + TOKEN_TTL)
    return web.json_response({"url": f"/api/dl/{token}", "filename": meta["name"], "size": meta["size"]})


LOGO_MAX = 2 * 1024 ** 2


def sniff_image(head: bytes) -> str | None:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


async def upload_logo(request: web.Request) -> web.Response:
    _, app, _ = await owner_app(request)
    app_id = request.match_info["app_id"]
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "file":
        field = await reader.next()
    if field is None:
        return err(400, "No file received.")
    data = bytearray()
    while chunk := await field.read_chunk(256 * 1024):
        data += chunk
        if len(data) > LOGO_MAX:
            return err(413, "Logo is too large (max 2 MB).")
    kind = sniff_image(bytes(data[:16]))
    if not kind:
        return err(400, "Use a PNG, JPG, WEBP or GIF image.")
    folder = loader_dir(app_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "logo.bin").write_bytes(bytes(data))
    (folder / "logo.type").write_text(kind)
    version = hashlib.sha256(data).hexdigest()[:10]
    url = f"/api/logo/{app_id}?v={version}"
    await asyncio.to_thread(db.collection("apps").document(app_id).update, {"logoVersion": version})
    log.info("Logo uploaded for %s (%d bytes)", app_id, len(data))
    return web.json_response({"url": url, "size": len(data), "type": kind})


async def delete_logo(request: web.Request) -> web.Response:
    await owner_app(request)
    app_id = request.match_info["app_id"]
    folder = loader_dir(app_id)
    for f in ("logo.bin", "logo.type"):
        (folder / f).unlink(missing_ok=True)
    await asyncio.to_thread(db.collection("apps").document(app_id).update, {"logoVersion": firestore.DELETE_FIELD})
    return web.json_response({"ok": True})


async def serve_logo(request: web.Request) -> web.StreamResponse:
    folder = loader_dir(request.match_info["app_id"])
    path, kind = folder / "logo.bin", folder / "logo.type"
    if not path.exists() or not kind.exists():
        return err(404, "No logo.")
    return web.FileResponse(path, headers={
        "Content-Type": kind.read_text().strip(), "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300", "Cross-Origin-Resource-Policy": "cross-origin",
    })


def _check_and_activate(app_id: str, key: str, ip: str) -> dict:
    """Validate a license for an app and activate it on first use. Blocking."""
    blocked = db.collection("apps").document(app_id).collection("blacklist").where("value", "==", ip).limit(1).get()
    if blocked:
        return {"error": (403, "Access from your network is blocked.")}
    docs = db.collection("apps").document(app_id).collection("licenses").where("key", "==", key).limit(1).get()
    if not docs:
        return {"error": (404, "That key isn't valid.")}
    ref, lic = docs[0].reference, docs[0].to_dict()
    if lic.get("status") == "banned":
        return {"error": (403, "This key has been banned.")}
    now = datetime.now(timezone.utc)
    exp = lic.get("expiresAt")
    if isinstance(exp, datetime) and exp < now:
        return {"error": (403, "This key has expired.")}
    update = {"downloads": firestore.Increment(1), "lastDownloadAt": firestore.SERVER_TIMESTAMP}
    if lic.get("status", "unused") == "unused":
        days = int(lic.get("days") or 0)
        update.update(status="used", usedBy=lic.get("usedBy") or "web download", activatedAt=firestore.SERVER_TIMESTAMP,
                      expiresAt=None if days == 0 else now + timedelta(days=days))
    ref.update(update)
    if lic.get("status", "unused") == "unused":
        _plog(app_id, f"Key {key} activated from the download page", "buyer", "redeem")
    return {"ok": True}


async def redeem(request: web.Request) -> web.Response:
    ip = client_ip(request)
    q, now = ATTEMPTS[ip], time.monotonic()
    while q and now - q[0] > REDEEM_WINDOW:
        q.popleft()
    if len(q) >= REDEEM_LIMIT:
        return err(429, "Too many attempts. Wait a few minutes and try again.")
    q.append(now)
    try:
        body = await request.json()
    except Exception:
        return err(400, "Send a key.")
    key = str(body.get("key", "")).strip().upper()
    if not 4 <= len(key) <= 80:
        return err(400, "Enter your product key.")
    slug = request.match_info["slug"].lower()
    brand = await asyncio.to_thread(db.collection("brands").document(slug).get)
    if not brand.exists:
        return err(404, "This page doesn't exist.")
    app_id = brand.get("appId")
    folder = loader_dir(app_id)
    if not (folder / "loader.bin").exists():
        return err(503, "The download isn't available yet. Contact the seller.")
    result = await asyncio.to_thread(_check_and_activate, app_id, key, ip)
    if "error" in result:
        return err(*result["error"])
    meta = json.loads((folder / "meta.json").read_text())
    token = secrets.token_urlsafe(24)
    TOKENS[token] = (folder / "loader.bin", meta["name"], time.time() + TOKEN_TTL)
    q.clear()
    b = brand.to_dict()
    return web.json_response({"url": f"/api/dl/{token}", "filename": meta["name"], "size": meta["size"], "version": b.get("version", "")})


async def download(request: web.Request) -> web.StreamResponse:
    entry = TOKENS.pop(request.match_info["token"], None)
    if not entry or entry[2] < time.time() or not entry[0].exists():
        return err(410, "This download link has expired. Enter your key again.")
    path, name, _ = entry
    return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def _sweep():
    while True:
        await asyncio.sleep(60)
        now = time.time()
        for t in [t for t, v in TOKENS.items() if v[2] < now]:
            TOKENS.pop(t, None)


async def start() -> None:
    global DATA_DIR
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        (DATA_DIR / ".write-test").write_text("ok")
    except OSError:
        DATA_DIR = Path(__file__).parent / "data"
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        log.warning("DATA_DIR not writable; using %s (files are lost on redeploy — attach a Railway volume at /data)", DATA_DIR)
    app = web.Application(middlewares=[cors], client_max_size=max(MAX_BYTES.values()) + 1024 ** 2)
    app.add_routes(CLIENT_ROUTES)
    app.add_routes([
        web.get("/health", health),
        web.post("/api/apps/{app_id}/loader", upload_loader),
        web.delete("/api/apps/{app_id}/loader", delete_loader),
        web.post("/api/apps/{app_id}/logo", upload_logo),
        web.delete("/api/apps/{app_id}/logo", delete_logo),
        web.get("/api/logo/{app_id}", serve_logo),
        web.post("/api/panels/{grant_id}/keys", panel_generate),
        web.get("/api/panels/{grant_id}/keys", panel_keys),
        web.post("/api/panels/{grant_id}/download", panel_download),
        web.post("/api/panels/{grant_id}/keys/{lic_id}/{action}", panel_key_action),
        web.get("/api/panels/{grant_id}/sessions", panel_sessions),
        web.post("/api/panels/{grant_id}/sessions/{sid}/end", panel_session_end),
        web.get("/api/panels/{grant_id}/activity", panel_activity),
        web.post("/api/b/{slug}/redeem", redeem),
        web.get("/api/dl/{token}", download),
        web.route("OPTIONS", "/{tail:.*}", health),
    ])
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8080"))
    await web.TCPSite(runner, "0.0.0.0", port).start()
    asyncio.create_task(_sweep())
    log.info("API listening on :%d (data in %s)", port, DATA_DIR)
