import asyncio

import discord
from discord import app_commands
from discord.ext import commands

import config
import db
from cogs.common import deny, embed, is_staff, log_to_channel
from cogs.tickets import parse_topic, topic_for


def money(v) -> str:
    return f"{(v or 0):,.2f}"


def stats_embed(a: dict, title: str = "Your affiliate link") -> discord.Embed:
    link = f"{config.SITE_URL}/?ref={a['code']}"
    e = embed(title, f"Share this link, or tell buyers to enter the code **`{a['code']}`** when they open a purchase ticket.\n{link}")
    e.add_field(name="Commission", value=f"{a.get('rate', config.AFFILIATE_RATE)}%")
    e.add_field(name="Sales", value=str(a.get("sales", 0)))
    e.add_field(name="Status", value="Active" if a.get("active", True) else "Paused")
    e.add_field(name="Earned", value=money(a.get("earned")))
    e.add_field(name="Paid out", value=money(a.get("paid")))
    e.add_field(name="Owed to you", value=money(a.get("owed", round(a.get("earned", 0) - a.get("paid", 0), 2))))
    return e


class JoinView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=300)

    @discord.ui.button(label="Join the program", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, _):
        await interaction.response.defer(ephemeral=True)
        try:
            a = await asyncio.to_thread(db.create_affiliate, interaction.user.id, interaction.user.display_name)
        except db.AffiliateError as e:
            return await interaction.followup.send(embed=embed("Couldn't join", str(e), 0x555555), ephemeral=True)
        role = interaction.guild.get_role(config.AFFILIATE_ROLE_ID) if interaction.guild and config.AFFILIATE_ROLE_ID else None
        if role and isinstance(interaction.user, discord.Member):
            try:
                await interaction.user.add_roles(role, reason="Joined the affiliate program")
            except discord.HTTPException:
                pass
        await interaction.followup.send(embed=stats_embed(a, "You're in"), ephemeral=True)
        await log_to_channel(interaction.guild, embed=embed("New affiliate", f"{interaction.user.mention} · code `{a['code']}` · {a['rate']}%"))
        self.stop()


class Affiliates(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="affiliate", description="See your affiliate link and earnings, or join the program")
    async def affiliate(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        a = await asyncio.to_thread(db.affiliate_by_discord, interaction.user.id)
        if a:
            a = await asyncio.to_thread(db.affiliate_stats, a["code"])
            return await interaction.followup.send(embed=stats_embed(a), ephemeral=True)
        text = (f"Earn **{config.AFFILIATE_RATE}%** of every Sovyx plan sale you refer. You get a personal link and code. "
                "When a buyer uses your code and staff confirm their payment, the commission is added to your balance, and staff pay it out on request.\n"
                "You can't earn on your own purchases.")
        await interaction.followup.send(embed=embed("Sovyx affiliate program", text), view=JoinView(), ephemeral=True)

    @app_commands.command(name="affiliates", description="Staff: top affiliates")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def affiliates(self, interaction: discord.Interaction):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        await interaction.response.defer(ephemeral=True)
        rows = await asyncio.to_thread(db.top_affiliates, 15)
        if not rows:
            return await interaction.followup.send(embed=embed("Affiliates", "Nobody has joined yet."), ephemeral=True)
        lines = [f"`{a['code']}` · <@{a.get('discordId')}> · {a.get('rate')}% · {a.get('sales', 0)} sales · owed **{money(a.get('earned', 0) - a.get('paid', 0))}**"
                 + ("" if a.get("active", True) else " · paused") for a in rows]
        await interaction.followup.send(embed=embed("Affiliates", "\n".join(lines)), ephemeral=True)

    @app_commands.command(name="affiliate-set", description="Staff: change an affiliate's rate or pause them")
    @app_commands.describe(code="Their code", rate="Commission percent (0-90)", active="Turn crediting on or off")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def affiliate_set(self, interaction: discord.Interaction, code: str, rate: app_commands.Range[int, 0, 90] | None = None, active: bool | None = None):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        await interaction.response.defer(ephemeral=True)
        try:
            a = await asyncio.to_thread(db.set_affiliate, code, rate, active)
        except db.AffiliateError as e:
            return await interaction.followup.send(embed=embed("Couldn't update", str(e), 0x555555), ephemeral=True)
        await interaction.followup.send(embed=embed("Updated", f"`{a['code']}` is now {a.get('rate')}% and {'active' if a.get('active', True) else 'paused'}."), ephemeral=True)

    @app_commands.command(name="affiliate-payout", description="Staff: record a payout you made to an affiliate")
    @app_commands.describe(code="Their code", amount="Amount you paid them")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def affiliate_payout(self, interaction: discord.Interaction, code: str, amount: app_commands.Range[float, 0.01, 100000.0]):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        await interaction.response.defer(ephemeral=True)
        try:
            a = await asyncio.to_thread(db.payout, code, amount, f"discord:{interaction.user}")
        except db.AffiliateError as e:
            return await interaction.followup.send(embed=embed("Couldn't record", str(e), 0x555555), ephemeral=True)
        await interaction.followup.send(embed=embed("Payout recorded", f"`{a['code']}` was paid {money(amount)}. Still owed: **{money(a['owed'])}**."), ephemeral=True)
        await log_to_channel(interaction.guild, embed=embed("Affiliate payout", f"`{a['code']}` · {money(amount)} · by {interaction.user.mention}"))

    @app_commands.command(name="affiliate-adjust", description="Staff: add or remove earnings, e.g. for a sale with no readable price")
    @app_commands.describe(code="Their code", amount="Positive adds, negative removes", note="Why")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def affiliate_adjust(self, interaction: discord.Interaction, code: str, amount: app_commands.Range[float, -100000.0, 100000.0], note: str = "manual"):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        await interaction.response.defer(ephemeral=True)
        try:
            a = await asyncio.to_thread(db.adjust_earned, code, amount, note, f"discord:{interaction.user}")
        except db.AffiliateError as e:
            return await interaction.followup.send(embed=embed("Couldn't adjust", str(e), 0x555555), ephemeral=True)
        await interaction.followup.send(embed=embed("Adjusted", f"`{a['code']}` earned is now {money(a['earned'])}. Owed: **{money(a['owed'])}**."), ephemeral=True)

    @app_commands.command(name="affiliate-attach", description="Staff: credit this purchase ticket to an affiliate code")
    @app_commands.describe(code="The affiliate's code")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def affiliate_attach(self, interaction: discord.Interaction, code: str):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        t = parse_topic(interaction.channel)
        if not t or t["kind"] != "buy" or t["status"] != "open":
            return await deny(interaction, "Use this in a purchase ticket that hasn't been paid yet.")
        await interaction.response.defer(ephemeral=True)
        a = await asyncio.to_thread(db.get_affiliate, code)
        if not a or a.get("active") is False:
            return await interaction.followup.send(embed=embed("Couldn't attach", "That code doesn't exist or is paused.", 0x555555), ephemeral=True)
        await interaction.channel.edit(topic=topic_for({**t, "ref": a["code"]}))
        await interaction.followup.send(embed=embed("Code attached", f"This purchase will be credited to `{a['code']}` once payment is confirmed."), ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Affiliates(bot))
