"""Firestore access, using the same collections as sovyx.cc. All functions are blocking;
call them through asyncio.to_thread from the bot."""
import json
import re
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


# ---------- affiliates ----------
class AffiliateError(Exception):
    pass


def clean_code(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())[:20]


def parse_amount(price) -> float | None:
    """Pulls the first number out of a price string such as '$15' or '15 USD'."""
    m = re.search(r"\d+(?:[.,]\d+)?", str(price or ""))
    return float(m.group(0).replace(",", ".")) if m else None


def get_affiliate(code: str) -> dict | None:
    code = clean_code(code)
    if not code:
        return None
    snap = db.collection("affiliates").document(code).get()
    return snap.to_dict() if snap.exists else None


def affiliate_by_discord(discord_id: int) -> dict | None:
    docs = db.collection("affiliates").where("discordId", "==", str(discord_id)).limit(1).get()
    return docs[0].to_dict() if docs else None


def create_affiliate(discord_id: int, name: str, rate: int | None = None, code: str | None = None) -> dict:
    if affiliate_by_discord(discord_id):
        raise AffiliateError("You are already an affiliate.")
    base = clean_code(code or name) or "SVX"
    candidate = base
    for _ in range(8):
        if not db.collection("affiliates").document(candidate).get().exists:
            break
        candidate = f"{base[:16]}{_block()}"[:20]
    else:
        raise AffiliateError("Couldn't find a free code. Try again.")
    aff = {"code": candidate, "name": name[:60], "discordId": str(discord_id), "rate": rate if rate is not None else config.AFFILIATE_RATE,
           "active": True, "sales": 0, "earned": 0.0, "paid": 0.0, "createdAt": firestore.SERVER_TIMESTAMP}
    db.collection("affiliates").document(candidate).set(aff)
    log("Affiliate joined", f"{candidate} ({name})", f"discord:{discord_id}")
    return aff


def record_sale(code: str, ticket_id: int, buyer_id: int, plan: str, days: int, price) -> dict | None:
    """Credits an affiliate for a confirmed purchase. Returns None when nothing is credited
    (unknown or paused code, the buyer is the affiliate, or this ticket was already credited)."""
    aff = get_affiliate(code)
    if not aff or aff.get("active") is False or aff.get("discordId") == str(buyer_id):
        return None
    sale_ref = db.collection("affiliateSales").document(f"ticket-{ticket_id}")
    if sale_ref.get().exists:
        return None
    amount = parse_amount(price)
    rate = aff.get("rate", config.AFFILIATE_RATE)
    commission = round(amount * rate / 100, 2) if amount is not None else None
    sale_ref.set({"code": aff["code"], "ticket": str(ticket_id), "buyerId": str(buyer_id), "plan": plan, "days": days,
                  "amount": amount, "rate": rate, "commission": commission, "at": firestore.SERVER_TIMESTAMP})
    update = {"sales": firestore.Increment(1)}
    if commission is not None:
        update["earned"] = firestore.Increment(commission)
    db.collection("affiliates").document(aff["code"]).update(update)
    return {"code": aff["code"], "commission": commission, "amount": amount, "rate": rate}


def set_affiliate(code: str, rate: int | None, active: bool | None) -> dict:
    aff = get_affiliate(code)
    if not aff:
        raise AffiliateError("No affiliate has that code.")
    update = {}
    if rate is not None:
        update["rate"] = rate
    if active is not None:
        update["active"] = active
    if update:
        db.collection("affiliates").document(aff["code"]).update(update)
    return {**aff, **update}


def adjust_earned(code: str, amount: float, note: str, by: str) -> dict:
    """Staff correction, e.g. a sale whose price couldn't be read. Negative amounts reduce what is owed."""
    aff = get_affiliate(code)
    if not aff:
        raise AffiliateError("No affiliate has that code.")
    db.collection("affiliates").document(aff["code"]).update({"earned": firestore.Increment(round(amount, 2))})
    log("Affiliate adjusted", f"{aff['code']} {amount:+.2f} ({note})", by)
    return affiliate_stats(aff["code"])


def payout(code: str, amount: float, by: str) -> dict:
    aff = get_affiliate(code)
    if not aff:
        raise AffiliateError("No affiliate has that code.")
    amount = round(amount, 2)
    owed = round(aff.get("earned", 0) - aff.get("paid", 0), 2)
    if amount <= 0:
        raise AffiliateError("Enter an amount above zero.")
    if amount > owed + 0.005:
        raise AffiliateError(f"They are only owed {owed:.2f}.")
    db.collection("affiliates").document(aff["code"]).update({"paid": firestore.Increment(amount)})
    db.collection("affiliatePayouts").add({"code": aff["code"], "amount": amount, "by": by, "at": firestore.SERVER_TIMESTAMP})
    log("Affiliate payout", f"{aff['code']} {amount:.2f}", by)
    return affiliate_stats(aff["code"])


def affiliate_stats(code: str) -> dict:
    aff = get_affiliate(code) or {}
    aff["owed"] = round(aff.get("earned", 0) - aff.get("paid", 0), 2)
    return aff


def top_affiliates(limit: int = 10) -> list[dict]:
    rows = [d.to_dict() for d in db.collection("affiliates").limit(500).get()]
    rows.sort(key=lambda a: (a.get("sales", 0), a.get("earned", 0)), reverse=True)
    return rows[:limit]


# ---------- reseller panels (products + access) ----------
DEFAULT_COSTS = {"1": 1, "7": 3, "30": 8, "90": 20, "0": 50}


def admin_uid() -> str | None:
    """The Sovyx account of the first admin, used as owner of product apps the bot creates."""
    for d in db.collection("admins").limit(20).get():
        email = (d.to_dict() or {}).get("email")
        if email:
            found = db.collection("users").where("email", "==", email).limit(1).get()
            if found:
                return found[0].id
    return None


def ensure_products(products: list[dict], owner_uid: str | None) -> dict:
    """Makes sure each catalog product exists (and has an app to hold its keys). Existing ones are left alone.
    Returns {"created": [...], "no_app": [...]}."""
    created, no_app = [], []
    for i, p in enumerate(products):
        ref = db.collection("products").document(p["key"])
        snap = ref.get()
        data = snap.to_dict() if snap.exists else None
        if data and data.get("appId"):
            continue
        app_id = None
        if owner_uid:
            _, app_ref = db.collection("apps").add({
                "ownerUid": owner_uid, "name": p["name"], "version": "1.0.0", "secret": secrets.token_hex(24),
                "sellerKey": secrets.token_hex(16), "hwidLock": True, "createdAt": firestore.SERVER_TIMESTAMP})
            app_id = app_ref.id
        if data:
            if app_id:
                ref.update({"appId": app_id})
        else:
            ref.set({"name": p["name"], "prefix": p["prefix"], "active": True, "appId": app_id, "costs": dict(DEFAULT_COSTS),
                     "order": i, "createdAt": firestore.SERVER_TIMESTAMP})
        if data is None or app_id:
            created.append(p["name"])
        if not app_id:
            no_app.append(p["name"])
    return {"created": created, "no_app": no_app}


def grant_panel(discord_id: int, product_key: str, days: int, credits: int, by: str, note: str) -> dict:
    """Gives (or extends) a reseller panel for the Sovyx account linked to this Discord user."""
    found = user_by_discord(discord_id)
    if not found:
        raise RedeemError(f"No Sovyx account is linked to this Discord user. They need to sign in once at {config.SITE_URL}/login with **Continue with Discord**.")
    uid, user = found
    if user.get("banned"):
        raise RedeemError("This account is suspended.")
    psnap = db.collection("products").document(product_key).get()
    prod = psnap.to_dict() if psnap.exists else None
    if not prod or not prod.get("appId"):
        raise RedeemError("That product isn't set up yet. Open Admin → Products and make sure it shows Ready.")
    gid = f"{uid}_{product_key}"
    gref = db.collection("panelAccess").document(gid)
    gsnap = gref.get()
    old = gsnap.to_dict() if gsnap.exists else None
    now = datetime.now(timezone.utc)
    old_exp = (old or {}).get("expiresAt")
    if days == 0 or old_exp == 0:
        expires = 0
    else:
        base = old_exp if isinstance(old_exp, datetime) and old_exp > now else now
        expires = base + timedelta(days=days)
    gref.set({
        "uid": uid, "email": user.get("email"), "username": user.get("username", ""), "productId": product_key, "productName": prod.get("name", product_key),
        "canGenerate": True, "canDownload": True, "canManage": True, "canSessions": True, "canActivity": False,
        "keyScope": (old or {}).get("keyScope", "own"), "credits": int((old or {}).get("credits") or 0) + credits,
        "expiresAt": expires, "status": "active", "note": note, "keysMade": (old or {}).get("keysMade", 0),
        "createdAt": (old or {}).get("createdAt") or firestore.SERVER_TIMESTAMP, "createdBy": (old or {}).get("createdBy") or by,
    })
    if not user.get("portalMode") and (user.get("plan") or "free") == "free" and not db.collection("apps").where("ownerUid", "==", uid).limit(1).get():
        db.collection("users").document(uid).update({"portalMode": "products"})     # a pure reseller gets the clean, products-only portal
    log("Panel sold", f"{user.get('email')}: {prod.get('name')} ({'lifetime' if days == 0 else f'{days} days'}, +{credits} credits)", by)
    return {"email": user.get("email"), "name": prod.get("name"), "expires": expires, "credits": int((old or {}).get("credits") or 0) + credits, "extended": bool(old)}


# ---------- remembered Discord server setup ----------
def load_discord_settings() -> dict:
    return db.collection("settings").document("discord").get().to_dict() or {}


def save_discord_settings(data: dict) -> None:
    db.collection("settings").document("discord").set(data, merge=True)
