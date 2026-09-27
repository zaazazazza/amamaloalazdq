const { isAdmin } = require('../utils/permissions');
const { adminPanel } = require('../services/panelService');
async function execute(message) {
  if (!isAdmin(message.member)) return message.reply('Vous n’avez pas la permission d’ouvrir le panel administrateur.');
  return message.channel.send(adminPanel());
}
module.exports = { execute };
