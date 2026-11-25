"""/setup-server builds (or refreshes) the whole Discord layout: roles, categories, channels, permissions and the
embeds in them. It reuses what already exists and never deletes anything. /cleanup-server removes old channels,
but only after listing them and getting a confirmation."""
import asyncio
import logging

import discord
from discord import app_commands
from discord.ext import commands

import catalog
import config
import db
from cogs.common import deny, embed
from cogs.shop import ShopView, product_embed, shop_header
from cogs.tickets import PanelView, SupportView, plans_embed

log = logging.getLogger("sovyx.server")
PO = discord.PermissionOverwrite

# ---------------------------------------------------------------- layout
ROLES = [
    {"key": "staff", "name": "Staff", "color": 0xE11D48, "hoist": True, "config": "STAFF_ROLE_ID", "saved": "staffRoleId",
     "perms": dict(manage_messages=True, moderate_members=True, kick_members=True, manage_nicknames=True, view_channel=True)},
    {"key": "reseller", "name": "Reseller", "color": 0xF59E0B, "hoist": True, "config": "RESELLER_ROLE_ID", "saved": "resellerRoleId", "perms": {}},
    {"key": "customer", "name": "Customer", "color": 0x3ECF8E, "hoist": False, "config": "CUSTOMER_ROLE_ID", "saved": "customerRoleId", "perms": {}},
    {"key": "affiliate", "name": "Affiliate", "color": 0x60A5FA, "hoist": False, "config": "AFFILIATE_ROLE_ID", "saved": "affiliateRoleId", "perms": {}},
]

# access: read = everyone sees it, only staff post | chat = everyone talks | customers = everyone sees, customers talk
#         resellers = resellers talk | resellers-read = resellers see, only staff post | staff = staff only
LAYOUT = [
    {"key": "info", "name": "📌・INFORMATION", "access": "read", "channels": [
        {"key": "welcome", "name": "👋・welcome", "topic": "Start here.", "content": "welcome"},
        {"key": "rules", "name": "📜・rules", "topic": "Please read before chatting.", "content": "rules"},
        {"key": "announcements", "name": "📢・announcements", "topic": "News and releases."},
        {"key": "faq", "name": "❓・faq", "topic": "Quick answers to common questions.", "content": "faq"},
    ]},
    {"key": "shop", "name": "🛒・SHOP", "access": "read", "channels": [
        {"key": "products", "name": "🛒・panels", "topic": "Reseller panels. Prices and buy buttons.", "content": "products"},
        {"key": "plans", "name": "💎・sovyx-plans", "topic": "Sovyx licensing plans for sellers.", "content": "plans"},
        {"key": "payments", "name": "💳・payment-info", "topic": "How payment works.", "content": "payments"},
        {"key": "vouches", "name": "✅・vouches", "topic": "Customers: leave a vouch after your purchase.", "access": "customers", "content": "vouches"},
    ]},
    {"key": "community", "name": "💬・COMMUNITY", "access": "chat", "channels": [
        {"key": "general", "name": "💬・general", "topic": "Chat about anything."},
        {"key": "suggestions", "name": "💡・suggestions", "topic": "Ideas for products and the server."},
        {"key": "giveaways", "name": "🎁・giveaways", "topic": "Giveaways and trial keys.", "access": "read"},
        {"key": "lounge", "name": "🔊・Lounge", "voice": True},
    ]},
    {"key": "support", "name": "🎫・SUPPORT", "access": "read", "channels": [
        {"key": "ticket", "name": "🎫・open-a-ticket", "topic": "Need help? Open a ticket.", "content": "support"},
        {"key": "status", "name": "📊・status", "topic": "Current product status.", "content": "status"},
        {"key": "guides", "name": "📖・guides", "topic": "How to use Sovyx and your products.", "content": "guides"},
    ]},
    {"key": "partners", "name": "🤝・PARTNERS", "access": "read", "channels": [
        {"key": "affiliates", "name": "🤝・affiliates", "topic": "Earn a commission for referring sellers.", "content": "affiliates"},
        {"key": "reseller-news", "name": "📣・reseller-updates", "topic": "Updates for resellers.", "access": "resellers-read"},
        {"key": "reseller-lounge", "name": "🧰・reseller-lounge", "topic": "Resellers only.", "access": "resellers", "content": "reseller"},
    ]},
    {"key": "staff", "name": "🔒・STAFF", "access": "staff", "channels": [
        {"key": "staff-chat", "name": "🔒・staff-chat", "topic": "Staff only."},
        {"key": "logs", "name": "🧾・logs", "topic": "Sales, tickets and bot activity.", "log": True},
    ]},
    {"key": "tickets", "name": "🎟・TICKETS", "access": "staff", "tickets": True, "channels": []},
]


# ---------------------------------------------------------------- content
def content_for(key: str) -> list:
    """Returns [(embeds, view)] for a channel. Messages are matched to the bot's existing ones by position."""
    if key == "welcome":
        return [([embed("Welcome to Sovyx", "Sovyx gives people who sell software the server behind their product: license keys, device (HWID) locks, "
                        "live sessions, a download page and reseller panels.\n\n**Where to go**\n"
                        "🛒 **#panels** reseller panels and prices\n💎 **#sovyx-plans** licensing plans for your own software\n"
                        "🎫 **#open-a-ticket** purchases and support\n🤝 **#affiliates** earn by referring sellers\n\n"
                        f"Dashboard: {config.SITE_URL} · Docs: {config.SITE_URL}/docs")], None)]
    if key == "rules":
        rules = ["Be respectful. No harassment, hate or threats.", "No scams, chargebacks or fake vouches. Anyone caught is banned.",
                 "Don't share keys, accounts or panels. They are for the buyer only.",
                 "No spam, unsolicited DMs or advertising other services.",
                 "Keep tickets civil and use one ticket per issue. Staff will never ask for your password.",
                 "Staff decisions are final. If you disagree, open a support ticket calmly."]
        return [([embed("Server rules", "\n".join(f"**{i}.** {r}" for i, r in enumerate(rules, 1)))], None)]
    if key == "faq":
        qa = [("How do I buy?", "Open a purchase ticket from **#panels** or **#sovyx-plans**. Staff confirm your payment and your key or panel is delivered."),
              ("How long does delivery take?", "As soon as staff confirm payment. Tickets are answered in the order they arrive."),
              ("My key says it's locked to another device.", "Reset your HWID from the download page, or open a support ticket."),
              ("What is a reseller panel?", "Access to a product's reseller area: make keys from a credit balance, reset HWIDs, ban keys and watch live sessions."),
              ("Where do I sign in to my panel?", f"{config.SITE_URL}/login, then **My panels**. Use **Continue with Discord** so we can link your purchase.")]
        e = embed("Frequently asked questions")
        for q, a in qa:
            e.add_field(name=q, value=a, inline=False)
        return [([e], None)]
    if key == "products":
        msgs = [([shop_header()], None)]
        msgs += [([product_embed(p)], ShopView(p)) for p in catalog.PRODUCTS]
        return msgs
    if key == "plans":
        return [([None], PanelView())]            # the embed needs prices from the database; filled in by the builder
    if key == "payments":
        return [([embed("Payment", config.PAYMENT_INFO + "\n\nOnce a purchase ticket is open, staff post the details and confirm your payment there. "
                        "Never pay anyone outside a ticket.")], None)]
    if key == "vouches":
        return [([embed("Vouches", "Happy with your purchase? Leave a short vouch here. Customers can post; everyone can read.")], None)]
    if key == "support":
        return [([embed("Support", "Something not working? Open a ticket and describe the problem. A staff member will pick it up.\n\n"
                        f"Check **#faq** and {config.SITE_URL}/docs first, they cover most questions.")], SupportView())]
    if key == "status":
        return [([embed("Product status", "Staff post the current status of each product here, including updates and maintenance.\n\n"
                        "If something isn't working and it isn't mentioned here, open a ticket.")], None)]
    if key == "guides":
        return [([embed("Guides", f"**Docs:** {config.SITE_URL}/docs\n**Sign-in API and code examples:** {config.SITE_URL}/docs#api\n"
                        f"**Webhooks:** {config.SITE_URL}/docs#webhooks\n**Updates:** {config.SITE_URL}/updates")], None)]
    if key == "affiliates":
        return [([embed("Affiliate program", f"Earn **{config.AFFILIATE_RATE}%** of every Sovyx plan you refer. Type `/affiliate` to join and get your link and code.\n"
                        f"Details: {config.SITE_URL}/affiliates")], None)]
    if key == "reseller":
        return [([embed("Reseller lounge", "A place for resellers to talk shop. Panel questions go in a support ticket so we can see your account.")], None)]
    return []


# ---------------------------------------------------------------- permissions
def overwrites(guild: discord.Guild, access: str, roles: dict, voice: bool = False) -> dict:
    everyone, staff, reseller, customer = guild.default_role, roles["staff"], roles["reseller"], roles["customer"]
    full = dict(view_channel=True, send_messages=True, embed_links=True, attach_files=True, read_message_history=True)
    ow = {guild.me: PO(manage_channels=True, manage_messages=True, **full)}
    staff_ow = PO(manage_messages=True, **full)
    if voice:
        ow[everyone] = PO(view_channel=True, connect=True, speak=True)
        return ow
    if access == "staff":
        ow[everyone] = PO(view_channel=False)
        ow[staff] = staff_ow
    elif access in ("resellers", "resellers-read"):
        ow[everyone] = PO(view_channel=False)
        ow[reseller] = PO(view_channel=True, send_messages=access == "resellers", read_message_history=True, embed_links=True, attach_files=True)
        ow[staff] = staff_ow
    elif access == "read":
        ow[everyone] = PO(view_channel=True, send_messages=False, add_reactions=True, create_public_threads=False, create_private_threads=False, read_message_history=True)
        ow[staff] = staff_ow
    elif access == "customers":
        ow[everyone] = PO(view_channel=True, send_messages=False, add_reactions=True, read_message_history=True)
        for r in (customer, reseller, staff):
            ow[r] = PO(send_messages=True, embed_links=True, attach_files=True)
    else:                                                       # chat
        ow[everyone] = PO(view_channel=True, send_messages=True, embed_links=True, attach_files=True, read_message_history=True)
        ow[staff] = staff_ow
    return ow


# ---------------------------------------------------------------- builder
class SetupError(Exception):
    pass


async def sync_messages(channel: discord.TextChannel, bot_id: int, desired: list) -> str:
    """Make the bot's messages in this channel match `desired`: edit in place, add what's missing, remove extras."""
    existing = [m async for m in channel.history(limit=100, oldest_first=True) if m.author.id == bot_id]
    posted = edited = 0
    for i, (embeds, view) in enumerate(desired):
        if i < len(existing):
            await existing[i].edit(embeds=embeds, view=view)
            edited += 1
        else:
            await channel.send(embeds=embeds, view=view)
            posted += 1
    for extra in existing[len(desired):]:
        await extra.delete()
    return f"{posted} posted, {edited} updated"


async def build(guild: discord.Guild, bot: commands.Bot, invoker: discord.abc.User, say) -> list[str]:
    me = guild.me
    if not (me.guild_permissions.manage_channels and me.guild_permissions.manage_roles):
        raise SetupError("I need the **Manage Channels** and **Manage Roles** permissions. Give my role those (or Administrator), then run this again.")
    saved = await asyncio.to_thread(db.load_discord_settings)
    ids: dict = dict(saved.get("channels") or {})
    cats: dict = dict(saved.get("categories") or {})
    out: list[str] = []

    # roles
    roles: dict[str, discord.Role] = {}
    for spec in ROLES:
        role = None
        for rid in (getattr(config, spec["config"]), saved.get(spec["saved"])):
            role = guild.get_role(rid) if isinstance(rid, int) else None
            if role:
                break
        role = role or discord.utils.find(lambda r: r.name.lower() == spec["name"].lower(), guild.roles)
        if not role:
            role = await guild.create_role(name=spec["name"], colour=discord.Colour(spec["color"]), hoist=spec["hoist"], mentionable=spec["key"] != "staff",
                                           permissions=discord.Permissions(**spec["perms"]), reason="Sovyx server setup")
            out.append(f"Created role **{role.name}**")
        roles[spec["key"]] = role
        setattr(config, spec["config"], role.id)
        saved[spec["saved"]] = role.id
    await say("Roles ready. Building categories and channels…")

    # products (so the shop buttons have something to hand out)
    owner = await asyncio.to_thread(db.user_by_discord, invoker.id)
    owner_uid = owner[0] if owner else await asyncio.to_thread(db.admin_uid)
    made = await asyncio.to_thread(db.ensure_products, catalog.PRODUCTS, owner_uid)
    if made["created"]:
        out.append("Added products: " + ", ".join(made["created"]))
    if made["no_app"]:
        out.append("⚠️ No Sovyx account found to own the apps for: " + ", ".join(made["no_app"]) +
                   ". Sign in to sovyx.cc with Discord, then run this again (or open Admin → Products).")

    # categories and channels
    for ci, cat_spec in enumerate(LAYOUT):
        cat_ow = overwrites(guild, cat_spec["access"], roles)
        cat = guild.get_channel(cats.get(cat_spec["key"], 0)) or discord.utils.get(guild.categories, name=cat_spec["name"])
        if cat:
            await cat.edit(name=cat_spec["name"], overwrites=cat_ow)
        else:
            cat = await guild.create_category(cat_spec["name"], overwrites=cat_ow, reason="Sovyx server setup")
            out.append(f"Created category **{cat_spec['name']}**")
        cats[cat_spec["key"]] = cat.id
        if cat_spec.get("tickets"):
            config.TICKET_CATEGORY_ID, saved["ticketCategoryId"] = cat.id, cat.id

        for ch_spec in cat_spec["channels"]:
            voice = bool(ch_spec.get("voice"))
            access = ch_spec.get("access", cat_spec["access"])
            ow = overwrites(guild, access, roles, voice=voice)
            existing = guild.get_channel(ids.get(ch_spec["key"], 0))
            if not existing:
                pool = guild.voice_channels if voice else guild.text_channels
                existing = discord.utils.get(pool, name=ch_spec["name"], category=cat)
            if existing:
                await existing.edit(name=ch_spec["name"], category=cat, overwrites=ow, **({} if voice else {"topic": ch_spec.get("topic")}))
                ch = existing
            elif voice:
                ch = await guild.create_voice_channel(ch_spec["name"], category=cat, overwrites=ow, reason="Sovyx server setup")
                out.append(f"Created channel **{ch_spec['name']}**")
            else:
                ch = await guild.create_text_channel(ch_spec["name"], category=cat, overwrites=ow, topic=ch_spec.get("topic"), reason="Sovyx server setup")
                out.append(f"Created channel **{ch_spec['name']}**")
            ids[ch_spec["key"]] = ch.id
            if ch_spec.get("log"):
                config.LOG_CHANNEL_ID, saved["logChannelId"] = ch.id, ch.id
            if ch_spec.get("content") and not voice:
                desired = content_for(ch_spec["content"])
                if ch_spec["content"] == "plans":
                    desired = [([await plans_embed()], PanelView())]
                await sync_messages(ch, bot.user.id, desired)
        await say(f"{cat_spec['name']} done")

    # put the new categories at the top, in order
    for i, cat_spec in enumerate(LAYOUT):
        c = guild.get_channel(cats[cat_spec["key"]])
        if c and c.position != i:
            await c.edit(position=i)

    saved["channels"], saved["categories"], saved["guildId"] = ids, cats, guild.id
    await asyncio.to_thread(db.save_discord_settings, saved)
    return out


# ---------------------------------------------------------------- cleanup
def stale_channels(guild: discord.Guild, saved: dict, current_channel_id: int) -> list[discord.abc.GuildChannel]:
    """Channels and categories that aren't part of the layout. Tickets, system channels and the current channel are left alone."""
    keep = set((saved.get("channels") or {}).values()) | set((saved.get("categories") or {}).values()) | {current_channel_id}
    keep |= {c.id for c in (guild.rules_channel, guild.public_updates_channel, guild.system_channel, guild.afk_channel) if c}
    out = []
    for ch in guild.channels:
        if ch.id in keep or isinstance(ch, discord.CategoryChannel):
            continue
        topic = getattr(ch, "topic", None) or ""
        if topic.startswith("svx|"):
            continue
        if ch.category_id in set((saved.get("categories") or {}).values()):
            continue                                                       # a channel someone added inside one of our categories
        out.append(ch)
    return out


class ConfirmDelete(discord.ui.View):
    def __init__(self, channels: list, owner_id: int):
        super().__init__(timeout=120)
        self.channels, self.owner_id = channels, owner_id

    @discord.ui.button(label="Delete these channels", style=discord.ButtonStyle.danger)
    async def go(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await deny(interaction, "Only the person who ran the command can confirm.")
        await interaction.response.edit_message(content="Deleting…", embed=None, view=None)
        deleted = 0
        for ch in self.channels:
            try:
                await ch.delete(reason=f"Sovyx cleanup by {interaction.user}")
                deleted += 1
            except discord.HTTPException:
                pass
        empty = [c for c in interaction.guild.categories if not c.channels and c.name not in {s["name"] for s in LAYOUT}]
        for c in empty:
            try:
                await c.delete(reason="Sovyx cleanup: empty category")
            except discord.HTTPException:
                pass
        await interaction.edit_original_response(content=f"Deleted {deleted} channel(s) and {len(empty)} empty categor{'y' if len(empty) == 1 else 'ies'}.")
        self.stop()

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _):
        await interaction.response.edit_message(content="Cancelled. Nothing was deleted.", embed=None, view=None)
        self.stop()


class ConfirmBuild(discord.ui.View):
    def __init__(self, bot: commands.Bot, owner_id: int):
        super().__init__(timeout=120)
        self.bot, self.owner_id = bot, owner_id

    @discord.ui.button(label="Build the server", style=discord.ButtonStyle.success)
    async def go(self, interaction: discord.Interaction, _):
        if interaction.user.id != self.owner_id:
            return await deny(interaction, "Only the person who ran the command can confirm.")
        if Server.busy:
            return await deny(interaction, "A setup is already running.")
        Server.busy = True
        await interaction.response.edit_message(content="Building… this takes a minute.", embed=None, view=None)

        async def say(text: str):
            try:
                await interaction.edit_original_response(content=f"Building… {text}")
            except discord.HTTPException:
                pass
        try:
            lines = await build(interaction.guild, self.bot, interaction.user, say)
        except SetupError as e:
            return await interaction.edit_original_response(content=str(e))
        except discord.Forbidden:
            return await interaction.edit_original_response(content="Discord refused a change. Make sure my role is above the roles I manage and has **Manage Channels** and **Manage Roles**.")
        except Exception:  # noqa: BLE001
            log.exception("server setup failed")
            return await interaction.edit_original_response(content="Setup stopped because of an error. It's safe to run again; it picks up where it left off. Check the bot logs for details.")
        finally:
            Server.busy = False
        e = embed("Server ready", "\n".join(lines[:25]) or "Everything was already in place. Embeds and permissions were refreshed.", 0x3ECF8E)
        e.add_field(name="Next", value="Run `/cleanup-server` to remove your old channels.\nPost current product status in **#status**.\nPrices live in `bot/catalog.py`: edit and run this again to refresh the embeds.", inline=False)
        await interaction.edit_original_response(content=None, embed=e)
        self.stop()

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _):
        await interaction.response.edit_message(content="Cancelled.", embed=None, view=None)
        self.stop()


class Server(commands.Cog):
    busy = False

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="setup-server", description="Admin: build or refresh the Sovyx server layout (roles, categories, channels, shop)")
    @app_commands.default_permissions(administrator=True)
    @app_commands.guild_only()
    async def setup_server(self, interaction: discord.Interaction):
        if not interaction.user.guild_permissions.administrator:
            return await deny(interaction, "Administrators only.")
        cats = len(LAYOUT)
        chans = sum(len(c["channels"]) for c in LAYOUT)
        text = (f"This creates **{cats} categories**, **{chans} channels** and the roles Staff, Reseller, Customer and Affiliate, sets their permissions, "
                "posts the welcome, rules, shop and support embeds, and adds the panel products.\n\n"
                "Things that already exist are reused, and **nothing is deleted**. Running it again refreshes the embeds and resets permissions on the channels it manages.")
        await interaction.response.send_message(embed=embed("Build the server?", text), view=ConfirmBuild(self.bot, interaction.user.id), ephemeral=True)

    @app_commands.command(name="cleanup-server", description="Admin: delete old channels that aren't part of the new layout (asks first)")
    @app_commands.default_permissions(administrator=True)
    @app_commands.guild_only()
    async def cleanup_server(self, interaction: discord.Interaction):
        if not interaction.user.guild_permissions.administrator:
            return await deny(interaction, "Administrators only.")
        await interaction.response.defer(ephemeral=True)
        saved = await asyncio.to_thread(db.load_discord_settings)
        if not saved.get("channels"):
            return await interaction.followup.send("Run `/setup-server` first, so I know which channels to keep.", ephemeral=True)
        stale = stale_channels(interaction.guild, saved, interaction.channel_id)
        if not stale:
            return await interaction.followup.send("Nothing to clean up. Every channel is part of the layout.", ephemeral=True)
        names = "\n".join(f"• {c.name}" + (f" ({c.category.name})" if c.category else "") for c in stale[:40])
        more = f"\n…and {len(stale) - 40} more" if len(stale) > 40 else ""
        e = embed(f"Delete {len(stale)} channel(s)?", f"These aren't part of the new layout:\n{names}{more}\n\n"
                  "Open tickets, system channels and this channel are kept. **Deleted channels can't be recovered.** Empty old categories are removed too.", 0xF59E0B)
        await interaction.followup.send(embed=e, view=ConfirmDelete(stale, interaction.user.id), ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Server(bot))
