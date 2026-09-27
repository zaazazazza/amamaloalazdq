const {
  PermissionFlagsBits, ChannelType,
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const db = require('../database/database');
const { getConfig } = db;
const { slug } = require('../utils/formatting');
const { base } = require('../utils/embeds');

async function createSupportTicket(guild, user) {
  // Nettoyage automatique : si un ticket a été supprimé manuellement dans Discord,
  // son ancienne entrée ne doit plus compter dans la limite de 2 tickets.
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const channelIds = channels ? [...channels.keys()] : [...guild.channels.cache.keys()];
  db.cleanupStaleTickets(channelIds);

  const existing = db.findOpenSupportByCreator(user.id);
  if (existing) return { existing: true, channelId: existing.channel_id };
  const maxTickets = Math.max(1, Number(getConfig('maxOpenTicketsPerUser') || 2));
  const openCount = db.countOpenTicketsByCreator(user.id);
  if (openCount >= maxTickets) return { limit: true, maxTickets };

  const seq = db.nextSupportSequence();
  const staffRoleIds = [...new Set([
    ...(getConfig('supportRoleIds') || []),
    ...(getConfig('adminRoleIds') || [])
  ].map(String))];
  const roles = staffRoleIds.filter(id => /^\d{17,20}$/.test(id) && guild.roles.cache.has(id));
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...roles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }))
  ];
  const category = getConfig('supportCategoryId');
  const channel = await guild.channels.create({
    name: `support-${slug(user.username)}-${String(seq).padStart(3,'0')}`,
    type: ChannelType.GuildText,
    parent: category || undefined,
    permissionOverwrites: overwrites
  });
  db.createTicket({ channel_id: channel.id, creator_id: user.id, type: 'support', sequence: seq, created_at: Date.now() });
  await sendSupportMessage(channel, user, null);
  return { channel };
}

function supportMessagePayload(user, assignedTo) {
  const embed = base(
    `🎫 Ticket Support — ${user.username || user.id}`,
    `Bonjour <@${user.id}>,\n\nMerci d’avoir ouvert un ticket **SICARIO SH**. Décrivez votre demande clairement afin que le staff puisse vous aider rapidement.\n\n` +
    `### 📌 Informations\n` +
    `**Statut :** \`🟢 Ouvert\`\n` +
    `**Assigné à :** ${assignedTo ? `<@${assignedTo}>` : '`Personne pour le moment`'}\n` +
    `**Catégorie :** \`Support\`\n\n` +
    `### 🛠️ Staff\n` +
    `Utilisez **Prendre** pour réserver le ticket. Une fois assigné, les autres membres du staff ne pourront pas le reprendre.\n\n` +
    `*SICARIO SH • Support System*`
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:take').setLabel('Prendre').setEmoji('🚀').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket:release').setLabel('Libérer').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:actions').setLabel('Actions staff').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}

async function sendSupportMessage(channel, user, assignedTo) {
  return channel.send(supportMessagePayload(user, assignedTo));
}

async function buildTranscript(channel, ticket) {
  const messages = [];
  const maxMessages = 5000;
  let before;

  while (messages.length < maxMessages) {
    const page = await channel.messages.fetch({ limit: Math.min(100, maxMessages - messages.length), ...(before ? { before } : {}) });
    const pageMessages = [...page.values()];
    if (!pageMessages.length) break;
    messages.push(...pageMessages);
    const oldest = pageMessages.reduce((result, message) => message.createdTimestamp < result.createdTimestamp ? message : result);
    if (pageMessages.length < 100 || messages.length >= maxMessages || oldest.id === before) break;
    before = oldest.id;
  }

  messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);
  const blocks = messages.map(message => {
    const author = message.author?.tag || message.author?.username || 'Utilisateur inconnu';
    const lines = [`[${new Date(message.createdTimestamp).toISOString()}] ${author}${message.author?.bot ? ' [BOT]' : ''}`, message.content || '(message sans texte)'];
    for (const attachment of message.attachments.values()) lines.push(`Fichier : ${attachment.name || 'pièce jointe'} - ${attachment.url}`);
    for (const embed of message.embeds) {
      const summary = [embed.title, embed.description].filter(Boolean).join(' - ');
      if (summary) lines.push(`Embed : ${summary}`);
    }
    return lines.join('\n');
  });

  const maxBytes = 7 * 1024 * 1024;
  const header = `Transcription du ticket #${ticket.id}\nSalon : ${channel.name}\nCréé par : ${ticket.creator_id}\nCréé le : ${new Date(ticket.created_at).toISOString()}\n\n`;
  let usedBytes = Buffer.byteLength(header, 'utf8');
  let truncated = messages.length >= maxMessages;
  const included = [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    const blockBytes = Buffer.byteLength(`${block}\n\n`, 'utf8');
    if (usedBytes + blockBytes > maxBytes) {
      truncated = true;
      break;
    }
    included.push(block);
    usedBytes += blockBytes;
  }
  included.reverse();
  const notice = truncated ? 'Les messages les plus anciens ont été omis pour respecter la limite de taille.\n\n' : '';
  return { buffer: Buffer.from(`${header}${notice}${included.join('\n\n')}`, 'utf8'), truncated };
}

async function sendRatingRequest(client, ticket) {
  const user = await client.users.fetch(ticket.creator_id).catch(() => null);
  if (!user) return false;
  const row = new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map(rating => new ButtonBuilder()
      .setCustomId(`support:rate:${ticket.id}:${rating}`)
      .setLabel(String(rating))
      .setEmoji('⭐')
      .setStyle(rating < 3 ? ButtonStyle.Secondary : ButtonStyle.Success))
  );
  return user.send({
    embeds: [base('Votre avis sur le support', `Votre ticket **#${ticket.id}** est fermé. Quelle note donnez-vous à l’aide reçue ?`)],
    components: [row]
  }).then(() => true).catch(error => {
    console.error('Impossible d’envoyer la demande d’évaluation par MP:', error.message);
    return false;
  });
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Number(value) || 0;
}

async function sendInactiveTicketReminders(client) {
  const now = Date.now();
  const inactivityLimit = 24 * 60 * 60 * 1000;

  for (const ticket of db.getOpenSupportTickets()) {
    const lastActivity = timestamp(ticket.last_activity_at || ticket.created_at);
    if (!lastActivity || now - lastActivity < inactivityLimit || timestamp(ticket.last_reminded_at) >= lastActivity) continue;

    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:activity:keep').setLabel('Toujours besoin d’aide').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:activity:close').setLabel('Fermer le ticket').setStyle(ButtonStyle.Secondary)
    );
    const sent = await channel.send({
      content:`<@${ticket.creator_id}> — votre ticket est inactif depuis 24 h. Avez-vous toujours besoin d’aide ?`,
      allowedMentions:{ users:[ticket.creator_id] },
      components:[row]
    }).then(() => true).catch(error => {
      console.error(`Impossible d’envoyer le rappel du ticket ${ticket.id}:`, error.message);
      return false;
    });
    if (sent) db.markTicketReminderSent(ticket.channel_id, now);
  }
}

async function closeAndLog(channel, closer) {
  const ticket = db.closeTicket(channel.id, closer.id);
  if (!ticket) return;
  const logsId = getConfig('logsChannelId');
  const logChannel = await channel.guild.channels.fetch(logsId).catch(()=>null);
  if (logChannel?.isTextBased()) {
    const creator = `<@${ticket.creator_id}>`;
    const payload = {
      embeds: [base('Ticket fermé',
        `**Ticket :** \`${channel.name}\`\n**Créé par :** ${creator}\n**Fermé par :** ${closer}\n**Type :** \`${ticket.type}\`\n**Création :** <t:${Math.floor(ticket.created_at/1000)}:F>\n**Fermeture :** <t:${Math.floor(ticket.closed_at/1000)}:F>`
      )]
    };
    if (ticket.type === 'support') {
      try {
        const transcript = await buildTranscript(channel, ticket);
        payload.files = [new AttachmentBuilder(transcript.buffer, { name: `ticket-${ticket.id}-transcript.txt` })];
        if (transcript.truncated) payload.embeds[0].addFields({ name: 'Transcription', value: 'Historique partiel : limite de taille ou de messages atteinte.' });
      } catch (error) {
        console.error('Impossible de générer la transcription du ticket:', error.message);
        payload.embeds[0].addFields({ name: 'Transcription', value: 'Impossible de générer la transcription.' });
      }
    }
    await logChannel.send(payload).catch(error => console.error('Impossible d’envoyer les logs du ticket:', error.message));
  }
  if (ticket.type === 'support') await sendRatingRequest(channel.client, ticket);
  await channel.send({ embeds: [base('Ticket fermé', '*Ce salon va être supprimé dans quelques secondes.*')] }).catch(()=>{});
  setTimeout(() => channel.delete('Ticket fermé').catch(()=>{}), 4000);
}
module.exports = { createSupportTicket, sendSupportMessage, supportMessagePayload, buildTranscript, sendInactiveTicketReminders, closeAndLog };
