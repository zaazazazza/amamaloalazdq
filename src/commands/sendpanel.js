const { isAdmin } = require('../utils/permissions');
const { getConfig } = require('../database/database');
const { mainPanel } = require('../services/panelService');
async function execute(message) {
  if (!isAdmin(message.member)) return message.reply('Vous n’avez pas la permission de publier le panel.');
  const id = getConfig('panelChannelId');
  const channel = await message.guild.channels.fetch(id).catch(()=>null);
  if (!channel?.isTextBased()) return message.reply('Le salon du panel est introuvable ou invalide.');
  await channel.send(mainPanel());
  return message.reply('Panel envoyé.');
}
module.exports = { execute };
