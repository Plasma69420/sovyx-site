import asyncio
import io
import logging
import re

import discord
from discord import app_commands
from discord.ext import commands

import config
import db
from cogs.common import deny, duration_label, embed, is_staff, log_to_channel

log = logging.getLogger("sovyx.tickets")

# Ticket metadata lives in the channel topic: svx|<kind>|<user_id>|<plan>|<days>|<status>|<affiliate code>


def parse_topic(channel: discord.abc.GuildChannel) -> dict | None:
    topic = getattr(channel, "topic", None) or ""
    parts = topic.split("|")
    if len(parts) < 3 or parts[0] != "svx":
        return None
    t = {"kind": parts[1], "user_id": int(parts[2])}
    if t["kind"] == "buy" and len(parts) >= 6:
        t.update(plan=parts[3], days=int(parts[4]), status=parts[5], ref=parts[6] if len(parts) > 6 else "")
    return t


def topic_for(t: dict) -> str:
    return f"svx|buy|{t['user_id']}|{t['plan']}|{t['days']}|{t['status']}|{t.get('ref', '')}"


def find_open(guild: discord.Guild, kind: str, user_id: int) -> discord.TextChannel | None:
    for ch in guild.text_channels:
        t = parse_topic(ch)
        if t and t["kind"] == kind and t["user_id"] == user_id:
            return ch
    return None


async def open_ticket(interaction: discord.Interaction, kind: str, topic: str, first: discord.Embed, view: discord.ui.View):
    guild, user = interaction.guild, interaction.user
    existing = find_open(guild, kind, user.id)
    if existing:
        return await interaction.followup.send(f"You already have an open ticket: {existing.mention}", ephemeral=True)
    category = guild.get_channel(config.TICKET_CATEGORY_ID) if config.TICKET_CATEGORY_ID else None
    overwrites = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False),
        user: discord.PermissionOverwrite(view_channel=True, send_messages=True, attach_files=True, read_message_history=True),
        guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True, manage_channels=True, read_message_history=True),
    }
    staff = guild.get_role(config.STAFF_ROLE_ID) if config.STAFF_ROLE_ID else None
    if staff:
        overwrites[staff] = discord.PermissionOverwrite(view_channel=True, send_messages=True, attach_files=True, read_message_history=True)
    name = re.sub(r"[^a-z0-9-]", "", f"{kind}-{user.name}".lower())[:90] or kind
    channel = await guild.create_text_channel(name, category=category if isinstance(category, discord.CategoryChannel) else None,
                                              overwrites=overwrites, topic=topic, reason=f"{kind} ticket for {user}")
    ping = f"{user.mention}" + (f" {staff.mention}" if staff else "")
    await channel.send(content=ping, embed=first, view=view, allowed_mentions=discord.AllowedMentions(users=True, roles=True))
    await interaction.followup.send(f"Ticket opened: {channel.mention}", ephemeral=True)
    await log_to_channel(guild, embed=embed("Ticket opened", f"{channel.mention} · {kind} · {user.mention}"))


async def close_ticket(interaction: discord.Interaction):
    channel, t = interaction.channel, parse_topic(interaction.channel)
    if not t:
        return await deny(interaction, "This isn't a ticket channel.")
    if interaction.user.id != t["user_id"] and not is_staff(interaction.user):
        return await deny(interaction, "Only the ticket owner or staff can close this ticket.")
    await interaction.response.send_message(embed=embed("Closing", f"Closed by {interaction.user.mention}. This channel is deleted in 5 seconds."))
    lines = [f"Transcript of #{channel.name} ({t['kind']} ticket)", ""]
    async for m in channel.history(limit=None, oldest_first=True):
        text = m.content or ""
        for e in m.embeds:
            text += f" [embed: {e.title or ''} {e.description or ''}]".rstrip()
        for a in m.attachments:
            text += f" [file: {a.url}]"
        lines.append(f"[{m.created_at:%Y-%m-%d %H:%M}] {m.author}: {text.strip()}")
    data = "\n".join(lines).encode()
    opener = interaction.guild.get_member(t["user_id"])
    await log_to_channel(interaction.guild, embed=embed("Ticket closed", f"#{channel.name} · opened by <@{t['user_id']}> · closed by {interaction.user.mention}"),
                         file=discord.File(io.BytesIO(data), filename=f"{channel.name}.txt"))
    if opener:
        try:
            await opener.send(embed=embed("Your ticket was closed", f"Here's a copy of **#{channel.name}**."),
                              file=discord.File(io.BytesIO(data), filename=f"{channel.name}.txt"))
        except discord.HTTPException:
            pass
    await asyncio.sleep(5)
    await channel.delete(reason=f"Ticket closed by {interaction.user}")


class ReferralModal(discord.ui.Modal, title="Referral code"):
    code = discord.ui.TextInput(label="Affiliate code", max_length=20, placeholder="e.g. NATE")

    def __init__(self, picker: "PlanPicker"):
        super().__init__()
        self.picker = picker

    async def on_submit(self, interaction: discord.Interaction):
        a = await asyncio.to_thread(db.get_affiliate, self.code.value)
        if not a or a.get("active") is False:
            return await interaction.response.send_message(embed=embed("Code not found", "Check the spelling, or leave it blank.", 0x555555), ephemeral=True)
        self.picker.ref = a["code"]
        await interaction.response.send_message(embed=embed("Code applied", f"Your purchase will be credited to `{a['code']}`."), ephemeral=True)


class PlanPicker(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=300)
        self.plan, self.days, self.ref = "pro", 30, ""
        self.plan_select.options = [discord.SelectOption(label=v, value=k, default=k == self.plan) for k, v in config.PLANS.items()]
        self.days_select.options = [discord.SelectOption(label=v, value=str(k), default=k == self.days) for k, v in config.DURATIONS.items()]

    @discord.ui.select(placeholder="Plan", row=0)
    async def plan_select(self, interaction: discord.Interaction, select: discord.ui.Select):
        self.plan = select.values[0]
        await interaction.response.defer()

    @discord.ui.select(placeholder="Duration", row=1)
    async def days_select(self, interaction: discord.Interaction, select: discord.ui.Select):
        self.days = int(select.values[0])
        await interaction.response.defer()

    @discord.ui.button(label="Have a code?", style=discord.ButtonStyle.secondary, row=2)
    async def referral(self, interaction: discord.Interaction, _):
        await interaction.response.send_modal(ReferralModal(self))

    @discord.ui.button(label="Open ticket", style=discord.ButtonStyle.success, row=2)
    async def go(self, interaction: discord.Interaction, _):
        await interaction.response.defer(ephemeral=True, thinking=True)
        prices = await asyncio.to_thread(db.plan_prices)
        e = embed(f"Purchase · {config.PLANS[self.plan]}", config.PAYMENT_INFO)
        e.add_field(name="Plan", value=config.PLANS[self.plan])
        e.add_field(name="Duration", value=duration_label(self.days))
        e.add_field(name="Price", value=prices.get(self.plan) or "Staff will confirm")
        e.add_field(name="Buyer", value=interaction.user.mention, inline=False)
        if self.ref:
            e.add_field(name="Referral code", value=f"`{self.ref}`")
        topic = topic_for({"user_id": interaction.user.id, "plan": self.plan, "days": self.days, "status": "open", "ref": self.ref})
        await open_ticket(interaction, "buy", topic, e, BuyTicketView())
        self.stop()


class SupportModal(discord.ui.Modal, title="Get support"):
    subject = discord.ui.TextInput(label="Subject", max_length=100, placeholder="e.g. My key isn't working")
    details = discord.ui.TextInput(label="Details", style=discord.TextStyle.paragraph, max_length=1500, required=False)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        e = embed(f"Support · {self.subject.value}", self.details.value or "No details given.")
        e.add_field(name="Opened by", value=interaction.user.mention)
        e.add_field(name="Claimed by", value="Nobody yet")
        await open_ticket(interaction, "support", f"svx|support|{interaction.user.id}", e, SupportTicketView())


class PanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Buy a plan", style=discord.ButtonStyle.success, custom_id="svx:panel:buy", emoji="🛒")
    async def buy(self, interaction: discord.Interaction, _):
        await interaction.response.send_message(embed=embed("Choose a plan", "Pick a plan and duration, then open your ticket."), view=PlanPicker(), ephemeral=True)

    @discord.ui.button(label="Get support", style=discord.ButtonStyle.secondary, custom_id="svx:panel:support", emoji="💬")
    async def support(self, interaction: discord.Interaction, _):
        await interaction.response.send_modal(SupportModal())


class BuyTicketView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Confirm payment", style=discord.ButtonStyle.success, custom_id="svx:buy:confirm")
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not is_staff(interaction.user):
            return await deny(interaction, "Only staff can confirm payments.")
        t = parse_topic(interaction.channel)
        if not t or t["kind"] != "buy":
            return await deny(interaction, "This isn't a purchase ticket.")
        if t["status"] == "paid":
            return await deny(interaction, "A key was already sent for this ticket.")
        await interaction.response.defer()
        buyer = interaction.guild.get_member(t["user_id"]) or await interaction.client.fetch_user(t["user_id"])
        note = f"Discord ticket #{interaction.channel.name} for {buyer}"
        key = (await asyncio.to_thread(db.create_keys, t["plan"], t["days"], 1, note, f"discord:{interaction.user}"))[0]
        await interaction.channel.edit(topic=topic_for({**t, "status": "paid"}))
        button.disabled, button.label = True, "Paid"
        await interaction.message.edit(view=self)

        how = f"Redeem it at {config.SITE_URL}/portal#billing or with `/redeem` here."
        dm = embed("Your Sovyx key", f"Thanks for your purchase!\n\n**`{key}`**\n\n{how}")
        dm.add_field(name="Plan", value=config.PLANS[t["plan"]]).add_field(name="Duration", value=duration_label(t["days"]))
        try:
            await buyer.send(embed=dm)
            sent = "Also sent to your DMs."
        except discord.HTTPException:
            sent = "Your DMs are closed, so copy it from here."
        await interaction.followup.send(embed=embed("Payment confirmed", f"<@{t['user_id']}> your key: ||`{key}`||\n{sent}\n{how}", 0x3ECF8E))
        await log_to_channel(interaction.guild, embed=embed("Key sold", f"{config.PLANS[t['plan']]} · {duration_label(t['days'])} → <@{t['user_id']}> · confirmed by {interaction.user.mention}"))
        if t.get("ref"):                                   # never let affiliate bookkeeping get in the way of delivering the key
            try:
                prices = await asyncio.to_thread(db.plan_prices)
                sale = await asyncio.to_thread(db.record_sale, t["ref"], interaction.channel.id, t["user_id"], t["plan"], t["days"], prices.get(t["plan"]))
                if sale:
                    pay = f"commission {sale['commission']:.2f}" if sale["commission"] is not None else "price unreadable: use /affiliate-adjust to add the commission"
                    await log_to_channel(interaction.guild, embed=embed("Affiliate sale", f"`{sale['code']}` · {config.PLANS[t['plan']]} · {pay}"))
            except Exception:  # noqa: BLE001
                log.warning("affiliate sale failed for %s", t.get("ref"), exc_info=True)

    @discord.ui.button(label="Close", style=discord.ButtonStyle.danger, custom_id="svx:buy:close")
    async def close(self, interaction: discord.Interaction, _):
        await close_ticket(interaction)


class SupportTicketView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Claim", style=discord.ButtonStyle.primary, custom_id="svx:sup:claim")
    async def claim(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not is_staff(interaction.user):
            return await deny(interaction, "Only staff can claim tickets.")
        e = interaction.message.embeds[0] if interaction.message.embeds else embed("Support")
        for i, f in enumerate(e.fields):
            if f.name == "Claimed by":
                e.set_field_at(i, name="Claimed by", value=interaction.user.mention)
        button.disabled, button.label = True, f"Claimed by {interaction.user.display_name}"[:80]
        await interaction.response.edit_message(embed=e, view=self)
        await interaction.channel.send(f"{interaction.user.mention} will help you with this ticket.")

    @discord.ui.button(label="Close", style=discord.ButtonStyle.danger, custom_id="svx:sup:close")
    async def close(self, interaction: discord.Interaction, _):
        await close_ticket(interaction)


class Tickets(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="panel", description="Post the Buy / Support ticket panel in this channel")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def panel(self, interaction: discord.Interaction):
        if not is_staff(interaction.user):
            return await deny(interaction, "Only staff can post the panel.")
        prices = await asyncio.to_thread(db.plan_prices)
        lines = [f"**{name}** — {prices.get(key) or 'ask staff'}" for key, name in config.PLANS.items()]
        e = embed("Sovyx", "Licensing, HWID locks and live sessions for your software.\n\n" + "\n".join(lines) +
                  f"\n\nClick **Buy a plan** to open a purchase ticket, or **Get support** if you need help.\nDashboard: {config.SITE_URL}")
        await interaction.channel.send(embed=e, view=PanelView())
        await interaction.response.send_message("Panel posted.", ephemeral=True)

    @app_commands.command(name="close", description="Close this ticket")
    @app_commands.guild_only()
    async def close(self, interaction: discord.Interaction):
        await close_ticket(interaction)


async def setup(bot: commands.Bot):
    bot.add_view(PanelView())
    bot.add_view(BuyTicketView())
    bot.add_view(SupportTicketView())
    await bot.add_cog(Tickets(bot))
