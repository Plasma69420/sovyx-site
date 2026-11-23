import logging

import discord
from discord.ext import commands

import api
import config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sovyx")


class SovyxBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True  # needed to save ticket transcripts
        super().__init__(command_prefix=commands.when_mentioned, intents=intents)

    async def setup_hook(self):
        await api.start()
        await self.load_extension("cogs.tickets")
        await self.load_extension("cogs.keys")
        if config.GUILD_ID:
            guild = discord.Object(id=config.GUILD_ID)
            self.tree.copy_global_to(guild=guild)
            synced = await self.tree.sync(guild=guild)
        else:
            synced = await self.tree.sync()
        log.info("Synced %d slash commands", len(synced))

    async def on_ready(self):
        log.info("Logged in as %s (%s)", self.user, self.user.id)
        await self.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="sovyx.cc"))


SovyxBot().run(config.DISCORD_TOKEN, log_handler=None)
