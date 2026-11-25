"""What the shop sells: reseller panels for each product.

A panel gives its owner a Sovyx "My panels" entry for one product: download the product, make keys from a
credit balance, reset HWIDs, ban keys and watch live sessions. Buying one in Discord creates that access
automatically once staff confirm payment.

Edit prices here and run /setup-server again to refresh the embeds. `days` 0 means lifetime.
`credits` are included with the panel and are spent on keys (the cost per key is set per product in the admin page).
The product `key` must match the product document id used by the site (the lowercase, dashed name)."""

PRODUCTS = [
    {
        "key": "fortnite-private", "name": "Fortnite Private", "prefix": "FNP", "emoji": "🎯", "color": 0xE11D48,
        "blurb": "Our flagship Fortnite product. Resell it to your own customers from your own panel.",
        "tiers": [{"days": 30, "price": 150, "credits": 150}, {"days": 0, "price": 450, "credits": 750}],
    },
    {
        "key": "roblox", "name": "Roblox", "prefix": "RBX", "emoji": "🧱", "color": 0x60A5FA,
        "blurb": "A Roblox product for resellers who want a steady line to sell.",
        "tiers": [{"days": 30, "price": 120, "credits": 120}, {"days": 0, "price": 360, "credits": 600}],
    },
    {
        "key": "temp-spoofer", "name": "Temp Spoofer", "prefix": "TSP", "emoji": "🕶️", "color": 0xFBBF24,
        "blurb": "A temporary HWID spoofer. Easy to sell, with regular repeat buyers.",
        "tiers": [{"days": 30, "price": 100, "credits": 100}, {"days": 0, "price": 300, "credits": 500}],
    },
    {
        "key": "perm-spoofer", "name": "Perm Spoofer", "prefix": "PSP", "emoji": "🔒", "color": 0x3ECF8E,
        "blurb": "A permanent HWID spoofer. Higher price, higher margin for resellers.",
        "tiers": [{"days": 30, "price": 150, "credits": 150}, {"days": 0, "price": 450, "credits": 750}],
    },
]

INCLUDED = ("Download the product", "Make keys from your credits", "Reset HWIDs and ban keys", "See live sessions")


def by_key(key: str) -> dict | None:
    return next((p for p in PRODUCTS if p["key"] == key), None)


def tier(product: dict, days: int) -> dict | None:
    return next((t for t in product["tiers"] if t["days"] == days), None)


def length_label(days: int) -> str:
    return "Lifetime" if days == 0 else "1 month" if days == 30 else f"{days} days"


def money(v: int | float) -> str:
    return f"${v:,.0f}" if float(v).is_integer() else f"${v:,.2f}"
