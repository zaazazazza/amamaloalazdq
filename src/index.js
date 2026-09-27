const { loadEnv } = require('./utils/loadEnv');
loadEnv();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const ready = require('./events/ready');
const messageCreate = require('./events/messageCreate');
const interactionCreate = require('./events/interactionCreate');
const database = require('./database/database');
const accessService = require('./services/accessService');
const { flush } = require('./services/remoteStore');

const bot1Token = process.env.BOT1_TOKEN || process.env.DISCORD_TOKEN;
if (!bot1Token) {
  console.error('BOT1_TOKEN manquant. Copiez .env.example vers .env et ajoutez le token du Bot 1.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => ready(client));
client.on('messageCreate', messageCreate);
client.on('interactionCreate', interactionCreate);

process.on('unhandledRejection', console.error);
process.on('uncaughtException', error => {
  console.error('[BOT 1] Exception non gérée, arrêt du processus:', error);
  process.exit(1);
});

Promise.all([database.syncFromRemote(), accessService.syncFromRemote()])
  .then(() => client.login(bot1Token))
  .catch(error => {
    console.error('[BOT 1] Synchronisation ou connexion Discord impossible:', error.message);
    process.exit(1);
  });

async function shutdown(signal) {
  console.log(`[BOT 1] Arrêt demandé (${signal}).`);
  await flush();
  client.destroy();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
