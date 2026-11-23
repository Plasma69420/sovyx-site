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

from db import db

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


def client_ip(request: web.Request) -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else (request.remote or "?")


def err(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


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
    app.add_routes([
        web.get("/health", health),
        web.post("/api/apps/{app_id}/loader", upload_loader),
        web.delete("/api/apps/{app_id}/loader", delete_loader),
        web.post("/api/apps/{app_id}/logo", upload_logo),
        web.delete("/api/apps/{app_id}/logo", delete_logo),
        web.get("/api/logo/{app_id}", serve_logo),
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
