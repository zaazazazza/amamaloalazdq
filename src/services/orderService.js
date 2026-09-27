const {
  PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const db = require('../database/database');
const { getConfig } = db;
const { slug, money } = require('../utils/formatting');
const { generateInvoice } = require('../utils/invoiceGenerator');
const { base } = require('../utils/embeds');

async function createOrderTicket(guild, user, selection) {
  const maxTickets = Math.max(1, Number(getConfig('maxOpenTicketsPerUser') || 2));
  const openCount = db.countOpenTicketsByCreator(user.id);
  if (openCount >= maxTickets) return { limit: true, maxTickets };
  const invoice = generateInvoice();
  const roles = (getConfig('supportRoleIds') || []).filter(id => /^\d{17,20}$/.test(String(id)) && guild.roles.cache.has(String(id)));
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...roles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }))
  ];
  const category = getConfig('orderCategoryId');
  const channel = await guild.channels.create({
    name: `commande-${slug(user.username)}-${invoice.toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: category || undefined,
    permissionOverwrites: overwrites
  });

  db.createOrder({
    invoice, channel_id: channel.id, user_id: user.id, username: user.username,
    product: selection.product, variant: selection.variant,
    payment_method: selection.payment, base_price: selection.basePrice,
    fee: selection.fee, total_price: selection.totalPrice, created_at: Date.now()
  });

  const embed = base(`Commande — ${invoice}`,
    `Bonjour ${user}, votre demande est bien enregistrée.\n\n` +
    `### Récapitulatif\n` +
    `**Produit :** \`${selection.product}\`\n**Formule :** \`${selection.variant}\`\n**Paiement :** \`${selection.payment}\`\n\n` +
    `**Prix de base :** \`${money(selection.basePrice)}\`\n` +
    `**Frais :** \`${money(selection.fee)}\`\n` +
    `**Total à régler :** \`${money(selection.totalPrice)}\`\n\n` +
    (selection.payment === 'Litecoin'
      ? `### 🪙 Paiement Litecoin\n**Adresse :** \`${String(getConfig('litecoinAddress') || 'Adresse non configurée')}\`\n\n`
      : '') +
    `> **Invoice :** \`${invoice}\`\n> **Statut :** \`En attente de vérification\`\n\n` +
    `*Un modérateur, administrateur ou owner va examiner votre commande.*`
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('order:close').setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
  await channel.send({ embeds: [embed], components: [row] });
  return { channel, invoice };
}

function calculateFee(basePrice, payment) {
  let percent = 0;
  if (payment === 'PayPal') percent = Number(getConfig('paypalFeePercent') || 0);
  if (payment === 'Bank') percent = Number(getConfig('bankFeePercent') || 0);
  return Math.round((basePrice * percent / 100) * 100) / 100;
}

module.exports = { createOrderTicket, calculateFee };
