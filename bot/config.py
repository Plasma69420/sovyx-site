import os


def _int(name: str) -> int | None:
    v = os.getenv(name, "").strip()
    return int(v) if v.isdigit() else None


DISCORD_TOKEN = os.environ["DISCORD_TOKEN"]
FIREBASE_SERVICE_ACCOUNT = os.environ["FIREBASE_SERVICE_ACCOUNT"]

GUILD_ID = _int("GUILD_ID")
STAFF_ROLE_ID = _int("STAFF_ROLE_ID")
CUSTOMER_ROLE_ID = _int("CUSTOMER_ROLE_ID")
TICKET_CATEGORY_ID = _int("TICKET_CATEGORY_ID")
LOG_CHANNEL_ID = _int("LOG_CHANNEL_ID")
RESELLER_ROLE_ID = _int("RESELLER_ROLE_ID")
AFFILIATE_ROLE_ID = _int("AFFILIATE_ROLE_ID")

PAYMENT_INFO = os.getenv(
    "PAYMENT_INFO",
    "A staff member will post payment details here shortly. Once your payment is confirmed, your key is sent to your DMs.",
)
AFFILIATE_RATE = _int("AFFILIATE_RATE") or 20      # percent of each confirmed sale
SITE_URL = os.getenv("SITE_URL", "https://sovyx.cc")
BRAND_COLOR = 0xE11D48

PLANS = {"basic": "Basic", "pro": "Pro", "ultimate": "Ultimate"}
PLAN_PREFIX = {"basic": "BSC", "pro": "PRO", "ultimate": "ULT"}
DURATIONS = {7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year", 0: "Lifetime"}


_SAVED = (("STAFF_ROLE_ID", "staffRoleId"), ("CUSTOMER_ROLE_ID", "customerRoleId"), ("RESELLER_ROLE_ID", "resellerRoleId"),
          ("AFFILIATE_ROLE_ID", "affiliateRoleId"), ("TICKET_CATEGORY_ID", "ticketCategoryId"), ("LOG_CHANNEL_ID", "logChannelId"))


def apply_saved(saved: dict, override: bool = False) -> None:
    """Use the role and channel IDs that /setup-server created. Environment variables win unless override is set."""
    g = globals()
    for attr, key in _SAVED:
        if isinstance(saved.get(key), int) and (override or g.get(attr) is None):
            g[attr] = saved[key]
