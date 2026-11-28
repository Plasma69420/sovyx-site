"""Reseller panel shop: product embeds with Buy buttons, purchase tickets, and handing out the panel once staff confirm payment."""
import asyncio
import logging
from datetime import datetime

import discord
from discord.ext import commands

import catalog
import config
import db
from cogs.common import deny, embed, is_staff, log_to_channel
from cogs.tickets import close_ticket, open_ticket, orders_paused, parse_topic, topic_for

log = logging.getLogger("sovyx.shop")


def product_embed(p: dict) -> discord.Embed:
    lines = [f"**{catalog.length_label(t['days'])}** — {catalog.money(t['price'])} · {t['credits']} credits included" for t in p["tiers"]]
    e = embed(f"{p['emoji']} {p['name']} · Reseller panel", f"{p['blurb']}\n\n" + "\n".join(lines), p["color"])
    e.add_field(name="Every panel includes", value="\n".join(f"• {x}" for x in catalog.INCLUDED), inline=False)
    e.set_footer(text="Press a button to open a purchase ticket. Your panel is set up as soon as staff confirm payment.")
    return e


def shop_header() -> discord.Embed:
    return embed("Reseller panels", "A panel lets you sell a product to your own customers. Pick a product below, choose how long you want it, "
                 "and open a ticket. You'll need a Sovyx account linked to Discord: sign in once at "
                 f"{config.SITE_URL}/login with **Continue with Discord**.\n\nCredits are spent when you make keys, and staff can top yours up any time.")


class ShopView(discord.ui.View):
    """One per product. Button IDs are fixed so the buttons keep working after a restart."""

    def __init__(self, product: dict):
        super().__init__(timeout=None)
        self.product = product
        for t in product["tiers"]:
            b = discord.ui.Button(label=f"{catalog.length_label(t['days'])} · {catalog.money(t['price'])}",
                                  style=discord.ButtonStyle.success if t["days"] == 0 else discord.ButtonStyle.primary,
                                  custom_id=f"svx:shop:{product['key']}:{t['days']}", emoji="🛒")
            b.callback = self._make_callback(t["days"])
            self.add_item(b)

    def _make_callback(self, days: int):
        async def callback(interaction: discord.Interaction):
            await open_panel_ticket(interaction, self.product, days)
        return callback


async def open_panel_ticket(interaction: discord.Interaction, product: dict, days: int):
    if await orders_paused(interaction):
        return
    t = catalog.tier(product, days)
    if not t:
        return await deny(interaction, "That option isn't available any more.")
    await interaction.response.defer(ephemeral=True, thinking=True)
    e = embed(f"{product['emoji']} {product['name']} panel · {catalog.length_label(days)}", config.PAYMENT_INFO, product["color"])
    e.add_field(name="Price", value=catalog.money(t["price"])).add_field(name="Credits included", value=str(t["credits"]))
    e.add_field(name="Buyer", value=interaction.user.mention, inline=False)
    topic = topic_for({"kind": "panel", "user_id": interaction.user.id, "plan": product["key"], "days": days, "status": "open"})
    await open_ticket(interaction, "panel", topic, e, PanelTicketView())


class PanelTicketView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Confirm payment", style=discord.ButtonStyle.success, custom_id="svx:panel:confirm")
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not is_staff(interaction.user):
            return await deny(interaction, "Only staff can confirm payments.")
        t = parse_topic(interaction.channel)
        if not t or t["kind"] != "panel":
            return await deny(interaction, "This isn't a panel purchase ticket.")
        if t["status"] == "paid":
            return await deny(interaction, "This panel was already handed out.")
        product, tier = catalog.by_key(t["plan"]), None
        if product:
            tier = catalog.tier(product, t["days"])
        if not product or not tier:
            return await deny(interaction, "That product or length is no longer in the catalog. Hand the panel out from Admin → Panels instead.")
        await interaction.response.defer()
        try:
            r = await asyncio.to_thread(db.grant_panel, t["user_id"], product["key"], t["days"], tier["credits"],
                                        f"discord:{interaction.user}", f"Discord ticket #{interaction.channel.name} · {catalog.money(tier['price'])}")
        except db.RedeemError as e:                 # nothing is marked paid, so staff can press the button again after fixing it
            return await interaction.followup.send(embed=embed("Couldn't hand out the panel", str(e), 0x555555))
        await interaction.channel.edit(topic=topic_for({**t, "status": "paid"}))
        button.disabled, button.label = True, "Paid"
        await interaction.message.edit(view=self)

        buyer = interaction.guild.get_member(t["user_id"])
        role_note = ""
        role = interaction.guild.get_role(config.RESELLER_ROLE_ID) if config.RESELLER_ROLE_ID else None
        if buyer and role:
            try:
                await buyer.add_roles(role, reason="Bought a reseller panel")
                role_note = f"\nYou now have the {role.mention} role."
            except discord.HTTPException:
                pass
        exp = r["expires"]
        until = "Lifetime" if exp == 0 else discord.utils.format_dt(exp, "D") if isinstance(exp, datetime) else "—"
        how = f"Sign in at {config.SITE_URL}/login and open **My panels**."
        done = embed("Panel ready", f"<@{t['user_id']}> your **{r['name']}** panel is active.{role_note}\n{how}", 0x3ECF8E)
        done.add_field(name="Access until", value=until).add_field(name="Credits", value=str(r["credits"]))
        await interaction.followup.send(embed=done)
        try:
            dm = embed("Your panel is ready", f"Thanks for your purchase!\n\n**{r['name']}**, access until {until}, {r['credits']} credits.\n{how}")
            if buyer:
                await buyer.send(embed=dm)
        except discord.HTTPException:
            pass
        await log_to_channel(interaction.guild, embed=embed("Panel sold", f"{r['name']} · {catalog.length_label(t['days'])} · {catalog.money(tier['price'])} → <@{t['user_id']}> · confirmed by {interaction.user.mention}"))

    @discord.ui.button(label="Close", style=discord.ButtonStyle.danger, custom_id="svx:panel:close")
    async def close(self, interaction: discord.Interaction, _):
        await close_ticket(interaction)


class Shop(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot


async def setup(bot: commands.Bot):
    for p in catalog.PRODUCTS:
        bot.add_view(ShopView(p))
    bot.add_view(PanelTicketView())
    await bot.add_cog(Shop(bot))
