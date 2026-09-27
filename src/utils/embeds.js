const { EmbedBuilder } = require('discord.js');
const { getConfig } = require('../database/database');

const COLOR = 0x5B5BD6;

function banner(embed) {
  const url = String(getConfig('bannerUrl') || '').trim();
  if (/^https?:\/\//i.test(url)) embed.setImage(url);
  return embed;
}

function base(title, description = '') {
  const embed = new EmbedBuilder()
    .setColor(Number(getConfig('embedColor')) || COLOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'SICARIO SH • Secure System' })
    .setTimestamp();
  return banner(embed);
}

function cleanBlock(title, lines = []) {
  return `### ${title}\n${lines.filter(Boolean).join('\n')}`;
}

module.exports = { base, banner, cleanBlock, COLOR };
