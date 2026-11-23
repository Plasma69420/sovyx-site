import discord

import config


def is_staff(member: discord.abc.User) -> bool:
    if not isinstance(member, discord.Member):
        return False
    if member.guild_permissions.administrator:
        return True
    return bool(config.STAFF_ROLE_ID and any(r.id == config.STAFF_ROLE_ID for r in member.roles))


def embed(title: str, description: str = "", color: int = config.BRAND_COLOR) -> discord.Embed:
    e = discord.Embed(title=title, description=description, color=color)
    e.set_footer(text="Sovyx")
    return e


def duration_label(days: int) -> str:
    return config.DURATIONS.get(days, f"{days} days")


async def log_to_channel(guild: discord.Guild | None, **kwargs) -> None:
    if not guild or not config.LOG_CHANNEL_ID:
        return
    ch = guild.get_channel(config.LOG_CHANNEL_ID)
    if isinstance(ch, discord.TextChannel):
        try:
            await ch.send(**kwargs)
        except discord.HTTPException:
            pass


async def deny(interaction: discord.Interaction, text: str) -> None:
    send = interaction.followup.send if interaction.response.is_done() else interaction.response.send_message
    await send(embed=embed("Not allowed", text, 0x555555), ephemeral=True)
