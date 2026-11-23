import asyncio
import io
from datetime import datetime

import discord
from discord import app_commands
from discord.ext import commands

import config
import db
from cogs.common import deny, duration_label, embed, is_staff, log_to_channel

PLAN_CHOICES = [app_commands.Choice(name=v, value=k) for k, v in config.PLANS.items()]
DAY_CHOICES = [app_commands.Choice(name=v, value=k) for k, v in config.DURATIONS.items()]


def fmt_expiry(v) -> str:
    if v == 0:
        return "Never"
    if isinstance(v, datetime):
        return discord.utils.format_dt(v, "D")
    return "—"


class Keys(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ---------- customers ----------
    @app_commands.command(name="redeem", description="Redeem a Sovyx subscription key on your account")
    @app_commands.describe(key="Your key, e.g. SVX-PRO-XXXX-XXXX-XXXX")
    async def redeem(self, interaction: discord.Interaction, key: str):
        await interaction.response.defer(ephemeral=True, thinking=True)
        key = key.strip().upper()
        try:
            r = await asyncio.to_thread(db.redeem, interaction.user.id, key)
        except db.RedeemError as e:
            return await interaction.followup.send(embed=embed("Couldn't redeem", str(e), 0x555555), ephemeral=True)
        role_note = ""
        if config.CUSTOMER_ROLE_ID and isinstance(interaction.user, discord.Member):
            role = interaction.guild.get_role(config.CUSTOMER_ROLE_ID)
            if role:
                try:
                    await interaction.user.add_roles(role, reason="Redeemed a Sovyx key")
                    role_note = f"\nYou now have the {role.mention} role."
                except discord.HTTPException:
                    pass
        e = embed("Key redeemed", f"Your account **{r['email']}** is now on **{config.PLANS[r['plan']]}**.{role_note}\n\nOpen your dashboard: {config.SITE_URL}/portal", 0x3ECF8E)
        e.add_field(name="Expires", value=fmt_expiry(r["expires"]))
        await interaction.followup.send(embed=e, ephemeral=True)
        await log_to_channel(interaction.guild, embed=embed("Key redeemed", f"{interaction.user.mention} → {config.PLANS[r['plan']]} ({duration_label(r['days'])})"))

    @app_commands.command(name="hwid-reset", description="Ask staff to reset the device (HWID) bound to your account")
    async def hwid_reset(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            email = await asyncio.to_thread(db.request_hwid_reset, interaction.user.id)
        except db.RedeemError as e:
            return await interaction.followup.send(embed=embed("Couldn't request a reset", str(e), 0x555555), ephemeral=True)
        await interaction.followup.send(embed=embed("Request sent", "Staff will review your HWID reset shortly. You'll be able to use a new device once it's approved."), ephemeral=True)
        await log_to_channel(interaction.guild, embed=embed("HWID reset requested", f"{interaction.user.mention} ({email}) · approve it at {config.SITE_URL}/admin#hwid"))

    # ---------- staff ----------
    @app_commands.command(name="genkey", description="Staff: generate Sovyx subscription keys")
    @app_commands.describe(plan="Plan", duration="Length", amount="How many (1-50)", note="Optional note, e.g. order number")
    @app_commands.choices(plan=PLAN_CHOICES, duration=DAY_CHOICES)
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def genkey(self, interaction: discord.Interaction, plan: app_commands.Choice[str], duration: app_commands.Choice[int],
                     amount: app_commands.Range[int, 1, 50] = 1, note: str = ""):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        await interaction.response.defer(ephemeral=True, thinking=True)
        keys = await asyncio.to_thread(db.create_keys, plan.value, duration.value, amount, note or "Discord /genkey", f"discord:{interaction.user}")
        title = f"{amount} × {plan.name} · {duration.name}"
        if amount <= 10:
            await interaction.followup.send(embed=embed(title, "\n".join(f"`{k}`" for k in keys)), ephemeral=True)
        else:
            await interaction.followup.send(embed=embed(title, "Keys attached."), file=discord.File(io.BytesIO("\n".join(keys).encode()), filename="keys.txt"), ephemeral=True)
        await log_to_channel(interaction.guild, embed=embed("Keys generated", f"{title} by {interaction.user.mention}" + (f" · {note}" if note else "")))

    @app_commands.command(name="lookup", description="Staff: look up a key or a member's Sovyx account")
    @app_commands.describe(key="A subscription key", member="A Discord member")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def lookup(self, interaction: discord.Interaction, key: str | None = None, member: discord.Member | None = None):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        if not key and not member:
            return await interaction.response.send_message("Give a key or a member.", ephemeral=True)
        await interaction.response.defer(ephemeral=True, thinking=True)
        if key:
            k = await asyncio.to_thread(db.get_key, key.strip().upper())
            if not k:
                return await interaction.followup.send(embed=embed("Not found", f"No key `{key}`.", 0x555555), ephemeral=True)
            e = embed(f"Key {k['key']}")
            e.add_field(name="Plan", value=config.PLANS.get(k.get("plan"), k.get("plan")))
            e.add_field(name="Duration", value=duration_label(k.get("days", 30)))
            e.add_field(name="Status", value=f"Redeemed by {k.get('assignedEmail') or k.get('assignedTo')}" if k.get("assigned") else "Unused", inline=False)
            if k.get("note"):
                e.add_field(name="Note", value=k["note"], inline=False)
            return await interaction.followup.send(embed=e, ephemeral=True)
        found = await asyncio.to_thread(db.user_by_discord, member.id)
        if not found:
            return await interaction.followup.send(embed=embed("No account", f"{member.mention} hasn't linked Discord to a Sovyx account.", 0x555555), ephemeral=True)
        uid, u = found
        e = embed(f"{u.get('username') or u.get('email')}", u.get("email", ""))
        e.add_field(name="Plan", value=config.PLANS.get(u.get("plan"), "Free"))
        e.add_field(name="Expires", value=fmt_expiry(u.get("expiresAt")) if u.get("plan") not in (None, "free") else "—")
        e.add_field(name="Status", value="Banned" if u.get("banned") else "Active")
        e.add_field(name="Key", value=f"`{u['licenseKey']}`" if u.get("licenseKey") else "None", inline=False)
        e.add_field(name="HWID", value=f"`{u['hwid']}`" if u.get("hwid") else "Not bound", inline=False)
        e.set_footer(text=f"uid {uid}")
        await interaction.followup.send(embed=e, ephemeral=True)

    @app_commands.command(name="revoke", description="Staff: delete a key; if redeemed, the account drops to Free")
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def revoke(self, interaction: discord.Interaction, key: str):
        if not is_staff(interaction.user):
            return await deny(interaction, "Staff only.")
        await interaction.response.defer(ephemeral=True, thinking=True)
        k = await asyncio.to_thread(db.revoke, key.strip().upper(), f"discord:{interaction.user}")
        if not k:
            return await interaction.followup.send(embed=embed("Not found", f"No key `{key}`.", 0x555555), ephemeral=True)
        who = f" {k.get('assignedEmail') or 'The account'} was moved to Free." if k.get("assigned") else ""
        await interaction.followup.send(embed=embed("Key revoked", f"`{k['key']}` deleted.{who}"), ephemeral=True)
        await log_to_channel(interaction.guild, embed=embed("Key revoked", f"`{k['key']}` by {interaction.user.mention}"))


async def setup(bot: commands.Bot):
    await bot.add_cog(Keys(bot))
