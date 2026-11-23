"""Firestore access, using the same collections as sovyx.cc. All functions are blocking;
call them through asyncio.to_thread from the bot."""
import json
import secrets
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import credentials, firestore

import config

firebase_admin.initialize_app(credentials.Certificate(json.loads(config.FIREBASE_SERVICE_ACCOUNT)))
db = firestore.client()

_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class RedeemError(Exception):
    pass


def _block() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(4))


def make_key(plan: str) -> str:
    return f"SVX-{config.PLAN_PREFIX[plan]}-{_block()}-{_block()}-{_block()}"


def log(action: str, details: str, by: str) -> None:
    db.collection("activity").add({"action": action, "details": details, "admin": by, "at": firestore.SERVER_TIMESTAMP})


def plan_prices() -> dict:
    return db.collection("settings").document("plans").get().to_dict() or {}


def create_keys(plan: str, days: int, qty: int, note: str, by: str) -> list[str]:
    keys, batch = [], db.batch()
    for _ in range(qty):
        key = make_key(plan)
        keys.append(key)
        batch.set(db.collection("licenseKeys").document(key), {
            "key": key, "plan": plan, "days": days, "note": note, "assigned": False,
            "createdBy": by, "createdAt": firestore.SERVER_TIMESTAMP,
        })
    batch.commit()
    log("Keys generated", f"{qty} x {config.PLANS[plan]} {config.DURATIONS.get(days, f'{days} days')} ({note})", by)
    return keys


def user_by_discord(discord_id: int) -> tuple[str, dict] | None:
    docs = db.collection("users").where("discordId", "==", str(discord_id)).limit(1).get()
    return (docs[0].id, docs[0].to_dict()) if docs else None


def get_key(key: str) -> dict | None:
    snap = db.collection("licenseKeys").document(key).get()
    return snap.to_dict() if snap.exists else None


def redeem(discord_id: int, key: str) -> dict:
    found = user_by_discord(discord_id)
    if not found:
        raise RedeemError(f"No Sovyx account is linked to your Discord yet. Sign in once at {config.SITE_URL}/login with **Continue with Discord**, then try again.")
    uid, user = found
    if user.get("banned"):
        raise RedeemError("This account is suspended.")
    key_ref = db.collection("licenseKeys").document(key)
    user_ref = db.collection("users").document(uid)

    @firestore.transactional
    def run(tx):
        snap = key_ref.get(transaction=tx)
        if not snap.exists or snap.get("assigned"):
            raise RedeemError("That key doesn't exist or has already been used.")
        k = snap.to_dict()
        days = k.get("days", k.get("durationDays", 30))
        expires = 0 if days == 0 else datetime.now(timezone.utc) + timedelta(days=days)
        tx.update(user_ref, {"plan": k["plan"], "licenseKey": key, "expiresAt": expires})
        tx.update(key_ref, {"assigned": True, "assignedTo": uid, "assignedEmail": user.get("email"), "assignedAt": firestore.SERVER_TIMESTAMP})
        return {"plan": k["plan"], "days": days, "expires": expires, "email": user.get("email")}

    return run(db.transaction())


def revoke(key: str, by: str) -> dict | None:
    k = get_key(key)
    if not k:
        return None
    if k.get("assigned") and k.get("assignedTo"):
        user_ref = db.collection("users").document(k["assignedTo"])
        u = user_ref.get()
        if u.exists and u.get("licenseKey") == key:
            user_ref.update({"plan": "free", "licenseKey": None, "expiresAt": None})
    db.collection("licenseKeys").document(key).delete()
    log("Key revoked", key, by)
    return k


def request_hwid_reset(discord_id: int) -> str:
    found = user_by_discord(discord_id)
    if not found:
        raise RedeemError(f"No Sovyx account is linked to your Discord. Sign in at {config.SITE_URL}/login with Discord first.")
    uid, user = found
    pending = db.collection("hwid_resets").where("uid", "==", uid).where("status", "==", "pending").limit(1).get()
    if pending:
        raise RedeemError("You already have a pending HWID reset request.")
    db.collection("hwid_resets").add({
        "uid": uid, "email": user.get("email"), "username": user.get("username", ""),
        "status": "pending", "source": "discord", "requestedAt": firestore.SERVER_TIMESTAMP,
    })
    return user.get("email", "")
