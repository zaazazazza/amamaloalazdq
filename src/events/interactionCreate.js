const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const db = require('../database/database');
const { isStaff, isAdmin } = require('../utils/permissions');
const { base } = require('../utils/embeds');
const { money, truncate } = require('../utils/formatting');
const { createSupportTicket, sendSupportMessage, supportMessagePayload, closeAndLog } = require('../services/ticketService');
const { createOrderTicket, calculateFee } = require('../services/orderService');
const { grantAccess, exportAccessData } = require('../services/accessService');
const { getAccessGrants } = require('../services/remoteStore');
const { mainPanel, adminPanel } = require('../services/panelService');
const { getConfig } = require('../database/database');
const { isAuthorized: isRestockAuthorized, hasPending, getStockFiles, appendToService, createService } = require('../services/restockService');

const supportFaq = () => base('FAQ — Support',
`Avant d'ouvrir un ticket, prenez une minute pour vérifier les réponses ci-dessous.\n\n` +
`**Accès Premium / lignes qui ne fonctionnent pas**\nCertaines lignes peuvent ne plus être valides. Utilisez les lignes disponibles jusqu'à la fin du stock puis vérifiez-les sur le service concerné.\n\n` +
`**Je ne reçois pas mes récompenses gratuites**\nLes envois sont automatiques. Vérifiez l'activité du bot puis patientez un peu.\n\n` +
`**Comment fonctionne le générateur ?**\nLe générateur permet d'obtenir des comptes ou services selon l'offre sélectionnée. Les disponibilités peuvent varier.\n\n` +
`**Quand ont lieu les restocks ?**\nIls dépendent des disponibilités de l'équipe et des sessions de restock.\n\n` +
`**Les bots et le Sica Check servent à quoi ?**\nCes services correspondent aux offres disponibles chez SICARIO SH. Consultez le menu Commander pour voir les options et leurs prix.\n\n` +
`> Si votre question n'est pas résolue, vous pouvez continuer et créer votre ticket support.`
);

function orderProductMenu() {
  const products = db.getProducts(true).slice(0,25);
  return new StringSelectMenuBuilder().setCustomId('order:product').setPlaceholder('Que souhaitez-vous commander ?')
    .addOptions(products.map(p => ({ label: truncate(p.name,100), description: truncate(p.description || 'Service SICARIO SH',100), value: String(p.id) })));
}

function productVariantMenu(product) {
  return new StringSelectMenuBuilder().setCustomId(`order:variant:${product.id}`).setPlaceholder('Choisissez votre option')
    .addOptions(product.variants.slice(0,25).map((v,i)=>({ label: truncate(v.name,100), description: `${money(v.price)}`, value: String(i) })));
}

function paymentMenu(productId, variantIndex) {
  return new StringSelectMenuBuilder().setCustomId(`order:payment:${productId}:${variantIndex}`).setPlaceholder('Choisissez un moyen de paiement')
    .addOptions(
      { label:'PayPal', value:'PayPal' },
      { label:'Bank', value:'Bank' },
      { label:'Litecoin', value:'Litecoin' }
    );
}

function adminOnly(interaction) {
  return isAdmin(interaction.member);
}

function maintenanceMessage() {
  return String(getConfig('maintenanceMessage') || 'Le service est temporairement en maintenance. Merci de réessayer plus tard.');
}

function maintenanceReply(interaction) {
  return interaction.reply({ embeds:[base('🚧 Maintenance', maintenanceMessage())], ephemeral:true });
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\t\r-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function accessGrantsCsv(rows) {
  const columns = ['discord_user_id', 'lifetime', 'expires_at', 'added_by', 'added_at', 'duration_text'];
  return `\uFEFF${[columns, ...rows.map(row => columns.map(column => row[column] ?? ''))]
    .map(values => values.map(csvCell).join(','))
    .join('\r\n')}`;
}

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function isUnknownMessageError(error) {
  return error?.code === 10008 || error?.rawError?.code === 10008;
}

function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}

function restockMenu() {
  const services = getStockFiles();
  return new StringSelectMenuBuilder()
    .setCustomId('restock:select')
    .setPlaceholder('Choisissez le stock à alimenter')
    .addOptions([
      ...services.slice(0, 24).map(name => ({
        label: name,
        value: name,
        description: 'Ajouter le contenu du fichier à ce stock'
      })),
      { label: 'Créer un nouveau stock', value: '__new__', description: 'Créer un nouveau fichier .txt' }
    ]);
}

function restockEmbed(title, description) {
  return base(`📦 ${title}`, description);
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (error) {
    if (!isUnknownInteractionError(error) && !isUnknownMessageError(error)) console.error('Impossible de répondre à l’interaction:', error);
    return null;
  }
}


async function safeUpdate(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.update(payload);
  } catch (error) {
    if (!isUnknownInteractionError(error) && !isUnknownMessageError(error)) console.error('Impossible de mettre à jour l’interaction:', error);
    return null;
  }
}

async function refreshSupportTicketMessage(interaction, ticket, messageId = interaction.message.id) {
  const message = messageId === interaction.message.id
    ? interaction.message
    : await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;
  try {
    await message.edit(supportMessagePayload({ id: ticket.creator_id }, ticket.assigned_to));
    return true;
  } catch (error) {
    if (!isUnknownMessageError(error)) console.error('Impossible de mettre à jour le message du ticket:', error);
    return false;
  }
}

async function showOrderConfirmation(interaction, product, variant, payment) {
  const basePrice = Number(variant.price || 0);
  const fee = calculateFee(basePrice, payment);
  const total = basePrice + fee;
  const paymentInfo = payment === 'Litecoin'
    ? `### 🪙 Paiement Litecoin\n**Adresse :** \`${String(getConfig('litecoinAddress') || 'Adresse non configurée')}\`\n\n*Copiez l’adresse exactement avant d’effectuer le paiement.*`
    : '*Les frais éventuels liés au moyen de paiement sont inclus dans le total affiché.*';
  const embed = base('Confirmer votre commande',
    `### Vérification avant création\n**Produit :** \`${product.name}\`\n**Formule :** \`${variant.name}\`\n**Paiement :** \`${payment}\`\n\n**Prix de base :** \`${money(basePrice)}\`\n**Frais :** \`${money(fee)}\`\n**Total :** \`${money(total)}\`\n\n${paymentInfo}\n\n> En confirmant, un ticket privé sera créé avec votre récapitulatif.`
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`order:confirm:${product.id}:${encodeURIComponent(variant.name)}:${payment}`).setLabel('Confirmer').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel:order').setLabel('Retour').setStyle(ButtonStyle.Secondary)
  );
  await safeUpdate(interaction, { embeds:[embed], components:[row] });
}


async function grantServiceRoleAndNotify(interaction, order) {
  const guild = interaction.guild;
  if (!guild || !order?.user_id) return;

  const product = String(order.product || '').trim().toLowerCase();
  const generatorName = String(getConfig('generatorRoleName') || 'Accès Générateur').trim().toLowerCase();
  const sicaName = String(getConfig('sicaCheckProductName') || 'Sica Check').trim().toLowerCase();

  const member = await guild.members.fetch(String(order.user_id)).catch(() => null);
  if (!member) {
    console.error(`Impossible de trouver le membre ${order.user_id} dans ${guild.id}.`);
    return;
  }

  if (product === generatorName) {
    const roleId = String(getConfig('generatorRoleId') || '').trim();
    if (roleId) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (role) await member.roles.add(role, 'Commande Générateur acceptée').catch(error => {
        console.error('Impossible d’ajouter le rôle Générateur:', error);
      });
    }

    const inviteUrl = String(getConfig('generatorInviteUrl') || '').trim();
    if (inviteUrl) {
      await member.send(
        `✅ **Votre commande Générateur est active !**\n\n` +
        `Votre accès a été activé et le rôle correspondant vous a été ajouté.\n\n` +
        `🚀 **Serveur Générateur :** ${inviteUrl}`
      ).catch(() => {
        // Les MP fermés ne doivent pas faire échouer l'acceptation.
      });
    }
  }

  if (product === sicaName) {
    const roleId = String(getConfig('sicaCheckRoleId') || '').trim();
    if (roleId) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (role) await member.roles.add(role, 'Commande Sica Check acceptée').catch(error => {
        console.error('Impossible d’ajouter le rôle Sica Check:', error);
      });
    }

    const channelId = String(getConfig('sicaCheckTicketChannelId') || '').trim();
    if (channelId) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({
          content:
            `✅ <@${order.user_id}> **Sica Check activé !**\n` +
            `Votre commande \`${order.invoice}\` a été validée et le rôle Sica Check vous a été ajouté.`
        }).catch(error => console.error('Impossible d’envoyer le message Sica Check:', error));
      }
    }
  }
}

module.exports = async interaction => {
  try {
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith('support:rate:')) {
        const match = id.match(/^support:rate:(\d+):([1-5])$/);
        if (!match) return interaction.reply({ content:'Cette évaluation n’est pas valide.', ephemeral:true });
        await interaction.deferUpdate();
        const result = db.rateSupportTicket(match[1], interaction.user.id, Number(match[2]));
        if (!result.ok) {
          const messages = {
            not_found:'Ticket introuvable.',
            not_allowed:'Seul le créateur du ticket peut donner une note.',
            not_closed:'Ce ticket n’est pas encore fermé.',
            already_rated:'Une note a déjà été enregistrée pour ce ticket.',
            invalid_rating:'Cette note n’est pas valide.'
          };
          return interaction.editReply({ content:messages[result.reason] || 'Impossible d’enregistrer cette note.', embeds:[], components:[] });
        }

        await interaction.editReply({
          content:`Merci pour votre évaluation : **${result.ticket.rating}/5** ⭐`,
          embeds:[],
          components:[]
        });
        const logsId = getConfig('logsChannelId');
        const logChannel = await interaction.client.channels.fetch(logsId).catch(() => null);
        if (logChannel?.isTextBased()) {
          await logChannel.send({ embeds:[base('Évaluation du support',
            `**Ticket :** \`#${result.ticket.id}\`\n**Client :** <@${result.ticket.creator_id}>\n**Note :** ${'⭐'.repeat(result.ticket.rating)} (${result.ticket.rating}/5)\n**Staff assigné :** ${result.ticket.assigned_to ? `<@${result.ticket.assigned_to}>` : '*Non assigné*'}`
          )] }).catch(error => console.error('Impossible de journaliser l’évaluation:', error.message));
        }
        return null;
      }

      if (id === 'ticket:activity:keep' || id === 'ticket:activity:close') {
        const ticket = db.getTicketByChannel(interaction.channelId);
        if (!ticket || ticket.type !== 'support' || ticket.status !== 'open') {
          return interaction.reply({ content:'Ce ticket support n’est plus ouvert.', ephemeral:true });
        }
        if (String(ticket.creator_id) !== String(interaction.user.id)) {
          return interaction.reply({ content:'Seul le créateur du ticket peut répondre à ce rappel.', ephemeral:true });
        }
        if (id === 'ticket:activity:keep') {
          db.recordTicketActivity(ticket.channel_id);
          return interaction.update({ content:'Merci, le ticket reste ouvert. Le délai d’inactivité repart.', embeds:[], components:[] });
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('close:cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('close:confirm').setLabel('Confirmer la fermeture').setStyle(ButtonStyle.Danger)
        );
        return interaction.reply({ embeds:[base('Fermer le ticket ?', '*Cette action entraînera la fermeture définitive de ce ticket.*')], components:[row], ephemeral:true });
      }

      if (id === 'admin:restock') {
        if (!isRestockAuthorized(interaction.user.id)) {
          return interaction.reply({ content:'❌ Vous n’avez pas l’autorisation d’utiliser **Add Restock**.', ephemeral:true });
        }
        const channelId = getConfig('restockChannelId') || '1483803927223992326';
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          return interaction.reply({ content:`❌ Le salon de restock \`${channelId}\` est introuvable.`, ephemeral:true });
        }
        await interaction.reply({
          embeds:[restockEmbed('Add Restock', `📩 Les instructions viennent de t’être envoyées en **MP**.\n\nEnvoie ton fichier **.txt** dans le MP du bot, puis retourne dans <#${channelId}> pour choisir le stock à alimenter.`)],
          ephemeral:true
        });
        const dm = await interaction.user.send({
          embeds:[restockEmbed('Préparation du restock', `Envoie maintenant ton fichier **.txt** dans ce MP.\n\n> Le fichier reste privé et sera ensuite proposé dans le gestionnaire de restock.`)]
        }).catch(() => null);
        if (!dm) return interaction.followUp({ content:'❌ Je ne peux pas vous envoyer de MP. Activez vos messages privés puis recliquez sur **Add Restock**.', ephemeral:true });
        return null;
      }

      if (id.startsWith('restock:open:')) {
        const userId = id.split(':')[2];
        if (String(interaction.user.id) !== String(userId) || !isRestockAuthorized(interaction.user.id)) {
          return interaction.reply({ content:'❌ Ce gestionnaire de restock ne vous est pas destiné.', ephemeral:true });
        }
        if (!hasPending(interaction.user.id)) {
          return interaction.reply({ content:'❌ Aucun fichier `.txt` en attente. Clique d’abord sur **Add Restock** puis envoie ton fichier au bot en MP.', ephemeral:true });
        }
        const menu = restockMenu();
        return interaction.reply({
          embeds: [restockEmbed('Gestion du restock', `✅ Ton fichier a bien été reçu.\n\nChoisis maintenant **le stock à alimenter** ou crée un nouveau stock.\n\n> Le contenu du fichier ne sera ajouté qu’après ta confirmation.`)],
          components:[new ActionRowBuilder().addComponents(menu)],
          ephemeral:true
        });
      }

      if (id.startsWith('restock:confirm:')) {
        const service = id.split(':').slice(2).join(':');
        if (!isRestockAuthorized(interaction.user.id) || !hasPending(interaction.user.id)) {
          return interaction.reply({ content:'❌ Aucun restock valide n’est en attente.', ephemeral:true });
        }
        await interaction.deferUpdate();
        try {
          const result = appendToService(interaction.user.id, service);
          return interaction.editReply({
            embeds: [restockEmbed('Restock ajouté', `### ${result.name}\n\n> **+${result.added}** ligne(s) ajoutée(s)\n> **${result.total}** ligne(s) maintenant disponibles\n\n🟢 Le stock est prêt à être utilisé par le Bot 2.`)],
            content: '',
            components: []
          });
        } catch (error) {
          return interaction.editReply({
            embeds: [restockEmbed('Restock impossible', `❌ ${error.message || 'Une erreur inconnue est survenue.'}\n\n> Aucun contenu n’a été supprimé de ton fichier en attente.`)],
            content: '',
            components: []
          });
        }
      }

      if (id === 'restock:new') {
        if (!isRestockAuthorized(interaction.user.id) || !hasPending(interaction.user.id)) {
          return interaction.reply({ content:'❌ Aucun restock valide n’est en attente.', ephemeral:true });
        }
        const modal = new ModalBuilder().setCustomId('modal:restock:new').setTitle('Créer un stock');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Nom du restock').setPlaceholder('fortnite').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'panel:support') {
        if (getConfig('maintenanceMode')) return maintenanceReply(interaction);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('panel:main').setLabel('Retour').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('support:create').setLabel('Créer un ticket').setStyle(ButtonStyle.Primary)
        );
        await interaction.deferReply({ ephemeral:true });
        return interaction.editReply({ embeds:[supportFaq()], components:[row] });
      }
      if (id === 'panel:main') {
        await interaction.deferUpdate();
        return interaction.editReply(mainPanel());
      }

      if (id === 'support:create') {
        if (getConfig('maintenanceMode')) return maintenanceReply(interaction);
        await interaction.deferReply({ ephemeral:true });
        const result = await createSupportTicket(interaction.guild, interaction.user);
        if (result.existing) return interaction.editReply({ embeds:[base('🎫 Ticket déjà ouvert', `Vous avez déjà un ticket support ouvert : <#${result.channelId}>\n\n> Pour éviter les doublons, utilisez votre ticket actuel.`)] });
        if (result.limit) return interaction.editReply({ embeds:[base('🚫 Limite de tickets', `Vous avez déjà **${result.maxTickets} tickets ouverts**.\n\n> Fermez un ticket existant avant d’en créer un nouveau.`)] });
        return interaction.editReply({ embeds:[base('🎫 Ticket créé', `Votre ticket a été créé avec succès : ${result.channel}\n\n> Un membre du staff pourra le prendre en charge avec **Prendre**.`)] });
      }

      if (id === 'panel:order') {
        if (getConfig('maintenanceMode')) return maintenanceReply(interaction);
        await interaction.deferReply({ ephemeral:true });
        const products = db.getProducts(true);
        if (!products.length) return interaction.editReply({ content:'Aucun produit n’est actuellement disponible.' });
        const embed = base('Commander chez SICARIO SH', '*Que souhaitez-vous commander ?*');
        const row = new ActionRowBuilder().addComponents(orderProductMenu());
        return interaction.editReply({ embeds:[embed], components:[row] });
      }

      if (id === 'ticket:take') {
        if (!isStaff(interaction.member)) return interaction.reply({ content:'Action réservée au staff.', ephemeral:true });
        const current = db.getTicketByChannel(interaction.channel.id);
        if (!current || current.status !== 'open') return interaction.reply({ content:'❌ Ce ticket est introuvable ou déjà fermé.', ephemeral:true });
        if (current.assigned_to && String(current.assigned_to) !== String(interaction.user.id)) {
          return interaction.reply({ content:`🔒 Ce ticket est déjà pris en charge par <@${current.assigned_to}>.`, ephemeral:true });
        }
        await interaction.deferUpdate();
        const ticket = db.assignTicket(interaction.channel.id, interaction.user.id);
        if (!ticket) return interaction.followUp({ content:'❌ Ce ticket vient d’être pris en charge par un autre membre du staff.', ephemeral:true });
        await refreshSupportTicketMessage(interaction, ticket);
        return interaction.followUp({ content:'Ticket pris en charge.', ephemeral:true });
      }

      if (id === 'ticket:release') {
        if (!isStaff(interaction.member)) return interaction.reply({ content:'Action réservée au staff.', ephemeral:true });
        const current = db.getTicketByChannel(interaction.channel.id);
        if (!current || current.status !== 'open') return interaction.reply({ content:'❌ Ce ticket est introuvable ou déjà fermé.', ephemeral:true });
        if (current.assigned_to && String(current.assigned_to)!==String(interaction.user.id) && !isAdmin(interaction.member)) {
          return interaction.reply({ content:`🔒 Seul l’assigné <@${current.assigned_to}> ou un administrateur peut libérer ce ticket.`, ephemeral:true });
        }
        await interaction.deferUpdate();
        const ticket = db.releaseTicket(interaction.channel.id);
        if (!ticket) return interaction.followUp({ content:'Ce ticket est introuvable ou déjà fermé.', ephemeral:true });
        await refreshSupportTicketMessage(interaction, ticket);
        return interaction.followUp({ content:'Ticket libéré.', ephemeral:true });
      }

      if (id === 'ticket:actions') {
        if (!isStaff(interaction.member)) return interaction.reply({ content:'Action réservée au staff.', ephemeral:true });
        const ticket = db.getTicketByChannel(interaction.channel.id);
        if (!ticket || ticket.type !== 'support' || ticket.status !== 'open') {
          return interaction.reply({ content:'❌ Les actions staff sont disponibles uniquement dans un ticket support ouvert.', ephemeral:true });
        }
        await interaction.deferReply({ ephemeral:true });
        const menu = new StringSelectMenuBuilder().setCustomId(`ticket:staffaction:${interaction.message.id}`).setPlaceholder('Choisissez une action staff...')
          .addOptions(
            { label:'Ticket pris en charge', value:'take', description:'M’assigner ce ticket' },
            { label:'Ticket libéré', value:'release', description:'Désassigner ce ticket' },
            { label:'Renommer le ticket', value:'rename', description:'Modifier le nom du salon' },
            { label:'Verrouiller le ticket', value:'lock', description:'Empêcher le créateur d’écrire temporairement' },
            { label:'Déverrouiller le ticket', value:'unlock', description:'Rendre l’écriture au créateur' },
            { label:'Ajouter un membre', value:'add', description:'Ajouter quelqu’un au ticket' },
            { label:'Retirer un membre', value:'remove', description:'Retirer quelqu’un du ticket' },
            { label:'Notifier le créateur', value:'notify', description:'Mentionner le créateur dans le ticket' },
            { label:'Avez-vous toujours besoin de ce ticket ?', value:'ask', description:'Demander si le ticket est encore actif' }
          );
        return interaction.editReply({ components:[new ActionRowBuilder().addComponents(menu)] });
      }

      if (id === 'ticket:close' || id === 'order:close') {
        const ticketRecord = db.getTicketByChannel(interaction.channel.id);
        const orderRecord = db.getOrderByChannel(interaction.channel.id);
        const ownerId = ticketRecord?.creator_id || orderRecord?.user_id;
        if (!ownerId) return interaction.reply({ content:'Ce salon n’est pas un ticket géré.', ephemeral:true });
        if (String(ownerId) !== String(interaction.user.id) && !isStaff(interaction.member)) {
          return interaction.reply({ content:'Seul le créateur du ticket ou un membre du staff peut le fermer.', ephemeral:true });
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('close:cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('close:confirm').setLabel('Confirmer la fermeture').setStyle(ButtonStyle.Danger)
        );
        await interaction.deferReply({ ephemeral:true });
        return interaction.editReply({ embeds:[base('Fermer le ticket ?', '*Cette action entraînera la fermeture définitive de ce ticket.*')], components:[row] });
      }
      if (id === 'close:cancel') return safeUpdate(interaction, { content:'Fermeture annulée.', embeds:[], components:[] });
      if (id === 'close:confirm') {
        const ticketRecord = db.getTicketByChannel(interaction.channel.id);
        const orderRecord = db.getOrderByChannel(interaction.channel.id);
        const ownerId = ticketRecord?.creator_id || orderRecord?.user_id;
        if (!ownerId) return interaction.reply({ content:'Ce salon n’est pas un ticket géré.', ephemeral:true });
        if (String(ownerId) !== String(interaction.user.id) && !isStaff(interaction.member)) {
          return interaction.reply({ content:'Seul le créateur du ticket ou un membre du staff peut le fermer.', ephemeral:true });
        }
        await safeUpdate(interaction, { content:'Fermeture en cours…', embeds:[], components:[] });
        if (ticketRecord) return closeAndLog(interaction.channel, interaction.user);
        const order = db.cancelOrderByChannel(interaction.channel.id, interaction.user.id);
        if (order) {
          const logsId = getConfig('logsChannelId');
          const logChannel = await interaction.guild.channels.fetch(logsId).catch(()=>null);
          if (logChannel?.isTextBased()) {
            await logChannel.send({ embeds:[base('🗑️ Commande annulée', `**Invoice :** \`${order.invoice}\`\n**Client :** <@${order.user_id}>\n**Paiement :** \`${order.payment_method}\`\n**Fermée par :** ${interaction.user}`)] }).catch(()=>{});
          }
        }
        await interaction.channel.send({ embeds:[base('🔒 Ticket fermé','*Ce salon va être supprimé dans quelques secondes.*')] });
        return setTimeout(()=>interaction.channel.delete('Commande fermée').catch(()=>{}), 4000);
      }

      if (id === 'admin:dashboard') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const d = db.dashboard();
        const products = db.getProducts(false);
        const productLines = products.map(p=>`**${p.name} :** \`${d.byProduct[p.name] || 0}\``).join('\n') || '*Aucun produit*';
        return interaction.editReply({
          embeds:[base('Dashboard Financier',
`*Résumé de toutes les commandes acceptées.*\n\n## Totaux\n\n**Reçu des clients :** \`${money(d.total)}\`\n**Prix de base :** \`${money(d.base)}\`\n**Frais PayPal estimés :** \`${money(d.fees)}\`\n\n## Clients & Commandes\n\n**Clients uniques :** \`${d.uniqueClients}\`\n**Commandes payées :** \`${d.orders}\`\n\n## Par moyen de paiement\n\n**PayPal :** \`${money(d.byPayment.PayPal || 0)}\`\n**Bank / Revolut :** \`${money(d.byPayment.Bank || 0)}\`\n**Litecoin :** \`${money(d.byPayment.Litecoin || 0)}\`\n\n## Par produit\n\n${productLines}`)], ephemeral:true
        });
      }

      if (id === 'admin:maintenance') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const enabled = !Boolean(getConfig('maintenanceMode'));
        db.setConfig('maintenanceMode', enabled);
        await interaction.update(adminPanel());
        return interaction.followUp({ content:enabled ? 'Mode maintenance activé. Les nouvelles commandes et les nouveaux tickets sont suspendus.' : 'Mode maintenance désactivé. Les créations sont de nouveau disponibles.', ephemeral:true });
      }

      if (id === 'admin:maintenance-message') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const modal = new ModalBuilder().setCustomId('modal:maintenance-message').setTitle('Message de maintenance');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('message').setLabel('Message affiché aux membres').setStyle(TextInputStyle.Paragraph).setValue(maintenanceMessage().slice(0,1800)).setMaxLength(1800).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'admin:export-access') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const files = [new AttachmentBuilder(
          Buffer.from(JSON.stringify(exportAccessData(), null, 4), 'utf8'),
          { name:'access.json' }
        )];
        const supabaseRows = await getAccessGrants();
        let content = 'Export local joint : `access.json`.';
        if (supabaseRows === null) {
          content += '\nSupabase est indisponible : les exports distants n’ont pas pu être générés.';
        } else {
          files.push(
            new AttachmentBuilder(Buffer.from(JSON.stringify(supabaseRows, null, 2), 'utf8'), { name:'supabase-access-grants.json' }),
            new AttachmentBuilder(Buffer.from(accessGrantsCsv(supabaseRows), 'utf8'), { name:'supabase-access-grants.csv' })
          );
          content += `\nExports Supabase joints : ${supabaseRows.length} accès en JSON et CSV.`;
        }
        return interaction.editReply({ content, files });
      }

      if (id === 'admin:lookup') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const modal = new ModalBuilder().setCustomId('modal:lookup').setTitle('Lookup Invoice');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('invoice').setLabel('Invoice ID').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(8).setMaxLength(8)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'admin:orders') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('orders:list:pending').setLabel('En attente').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('orders:list:accepted').setLabel('Acceptées').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('orders:list:refused').setLabel('Refusées').setStyle(ButtonStyle.Danger)
        );
        return interaction.editReply({ embeds:[base('Commandes', '*Choisissez le statut à consulter.*')], components:[row] });
      }

      if (id.startsWith('orders:list:')) {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const status = id.split(':')[2];
        const rows = db.getOrders(status).slice(0,20);
        const lines = rows.length ? rows.map(o=>`• \`${o.invoice}\` — <@${o.user_id}> — **${o.product}** — \`${money(o.total_price)}\``).join('\n') : '*Aucune commande.*';
        return interaction.editReply({ embeds:[base(`Commandes — ${status}`, lines)] });
      }

      if (id === 'admin:products') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const menu = new StringSelectMenuBuilder().setCustomId('admin:productselect').setPlaceholder('Choisir un service à modifier')
          .addOptions(db.getProducts(false).slice(0,24).map(p=>({label:p.name,value:String(p.id),description:p.active?'Actif':'Désactivé'}))
            .concat([{label:'Ajouter un service',value:'new'}]));
        return interaction.editReply({ embeds:[base('Offres & Prix', '*Choisissez un service pour modifier son nom, sa description ou ses prix. Vous pouvez aussi en ajouter un nouveau.*\n\n**Format des prix :** `1 Jour = 1.60 | 3 Jours = 5 | 1 Semaine = 10 | À vie = 20`')], components:[new ActionRowBuilder().addComponents(menu)], ephemeral:true });
      }

      if (id === 'admin:config') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const menu = new StringSelectMenuBuilder().setCustomId('admin:configselect').setPlaceholder('Modifier une configuration')
          .addOptions(
            {label:'Salon du panel',value:'panelChannelId'},
            {label:'Salon des logs',value:'logsChannelId'},
            {label:'Rôles support (IDs séparés par virgules)',value:'supportRoleIds'},
            {label:'Rôles admin (IDs séparés par virgules)',value:'adminRoleIds'},
            {label:'Catégorie support',value:'supportCategoryId'},
            {label:'Catégorie commandes',value:'orderCategoryId'},
            {label:'Frais PayPal (%)',value:'paypalFeePercent'},
            {label:'Frais Bank (%)',value:'bankFeePercent'},
            {label:'URL de la bannière',value:'bannerUrl'},
            {label:'Couleur de l’embed (nombre hexadécimal)',value:'embedColor'}
          );
        return interaction.editReply({ embeds:[base('Configuration','*Sélectionnez un paramètre à modifier.*')], components:[new ActionRowBuilder().addComponents(menu)] });
      }

      if (id.startsWith('order:confirm:')) {
        const [, , productId, encodedVariant, payment] = id.split(':');
        await interaction.deferUpdate();
        if (getConfig('maintenanceMode')) return interaction.editReply({ embeds:[base('🚧 Maintenance', maintenanceMessage())], content:'', components:[] });
        const product = db.getProduct(Number(productId));
        const variantName = decodeURIComponent(encodedVariant);
        const variant = product?.variants.find(v=>v.name===variantName);
        if (!product || !variant) return interaction.editReply({ content:'Cette offre n’est plus disponible.', embeds:[], components:[] });
        const basePrice = Number(variant.price||0);
        const fee = calculateFee(basePrice,payment);
        const result = await createOrderTicket(interaction.guild, interaction.user, {
          product:product.name, variant:variant.name, payment, basePrice, fee, totalPrice:basePrice+fee
        });
        if (result.limit) return interaction.editReply({ embeds:[base('🚫 Limite de tickets', `Vous avez déjà **${result.maxTickets} tickets ouverts**.\n\n> Fermez un ticket existant avant de créer une nouvelle commande.`)], content:'', components:[] });
        return interaction.editReply({ embeds:[base('🛒 Ticket de commande créé', `Votre ticket est prêt : ${result.channel}\n\n**Invoice :** \`${result.invoice}\`\n**Paiement :** \`${payment}\`\n\n> Un membre du staff va vérifier votre commande.`)], content:'', components:[] });
      }
    }

    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const value = interaction.values[0];

      if (id === 'restock:select') {
        if (!isRestockAuthorized(interaction.user.id) || !hasPending(interaction.user.id)) {
          return interaction.reply({ content:'❌ Aucun restock valide n’est en attente.', ephemeral:true });
        }
        if (value === '__new__') {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('restock:new').setLabel('Créer le stock').setEmoji('📄').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('restock:cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary)
          );
          return interaction.update({
            embeds: [restockEmbed('Nouveau stock', `📄 Tu vas créer un **nouveau fichier de stock**.\n\nClique sur **Créer le stock** puis indique son nom.\n\nExemple : \`fortnite\``)],
            content: '',
            components:[row]
          });
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`restock:confirm:${value}`).setLabel('Confirmer le restock').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('restock:open').setLabel('Changer de fichier').setStyle(ButtonStyle.Secondary)
        );
        return interaction.update({
          embeds: [restockEmbed('Confirmer le restock', `📦 **Stock cible :** \`${value}.txt\`\n\nLe contenu de ton fichier **.txt** sera ajouté à ce stock.\n\n> Clique sur **Confirmer le restock** pour lancer l’ajout.`)],
          content: '',
          components:[row]
        });
      }

      if (id === 'restock:cancel') {
        return interaction.update({ embeds:[restockEmbed('Restock annulé', '❌ Le restock a été annulé.\n\n> Ton fichier reste en attente et pourra être traité plus tard.')], content:'', components:[] });
      }

      if (id === 'restock:open') {
        if (!isRestockAuthorized(interaction.user.id) || !hasPending(interaction.user.id)) {
          return interaction.reply({ content:'❌ Aucun restock valide n’est en attente.', ephemeral:true });
        }
        const menu = restockMenu();
        return interaction.update({
          embeds: [restockEmbed('Gestion du restock', `📦 Choisis maintenant **le stock à alimenter**.`)],
          content: '',
          components:[new ActionRowBuilder().addComponents(menu)]
        });
      }

      if (id === 'order:product') {
        await interaction.deferUpdate();
        const product = db.getProduct(Number(value));
        if (!product) return interaction.editReply({ content:'Produit introuvable.', embeds:[], components:[] });
        return interaction.editReply({
          embeds:[base(product.name, `${product.description || 'Service SICARIO SH'}\n\n### Formules disponibles\n${product.variants.map(v=>`**${v.name}** — \`${money(v.price)}\``).join('\n')}\n\n*Choisissez maintenant la formule qui vous convient.*`)],
          components:[new ActionRowBuilder().addComponents(productVariantMenu(product))]
        });
      }

      if (id.startsWith('order:variant:')) {
        await interaction.deferUpdate();
        const productId = Number(id.split(':')[2]);
        const product = db.getProduct(productId);
        const variant = product?.variants[Number(value)];
        if (!product || !variant) return interaction.editReply({ content:'Option introuvable.', embeds:[], components:[] });
        return interaction.editReply({
          embeds:[base('Mode de paiement', `### Votre sélection\n**Produit :** \`${product.name}\`\n**Formule :** \`${variant.name}\`\n**Prix :** \`${money(variant.price)}\`\n\nChoisissez votre moyen de paiement. Les éventuels frais sont affichés avant confirmation.`)],
          components:[new ActionRowBuilder().addComponents(paymentMenu(productId,value))]
        });
      }

      if (id.startsWith('order:payment:')) {
        const [, , productId, variantIndex] = id.split(':');
        const product = db.getProduct(Number(productId));
        const variant = product?.variants[Number(variantIndex)];
        if (!product || !variant) return interaction.reply({ content:'Offre introuvable.', ephemeral:true });
        return showOrderConfirmation(interaction, product, variant, value);
      }

      const staffActionMatch = id.match(/^ticket:staffaction:(\d{17,20})$/);
      if (staffActionMatch) {
        if (!isStaff(interaction.member)) return interaction.reply({ content:'Action réservée au staff.', ephemeral:true });
        const ticket = db.getTicketByChannel(interaction.channel.id);
        if (!ticket || ticket.type !== 'support' || ticket.status !== 'open') {
          return interaction.reply({ content:'❌ Les actions staff sont disponibles uniquement dans un ticket support ouvert.', ephemeral:true });
        }

        if (value === 'take') {
          if (ticket.assigned_to && String(ticket.assigned_to) !== String(interaction.user.id)) {
            return interaction.reply({ content:`🔒 Ce ticket est déjà pris en charge par <@${ticket.assigned_to}>.`, ephemeral:true });
          }
          await interaction.deferUpdate();
          const assignedTicket = db.assignTicket(interaction.channel.id, interaction.user.id);
          if (!assignedTicket) return interaction.followUp({ content:'❌ Ce ticket vient d’être pris en charge par un autre membre du staff.', ephemeral:true });
          await refreshSupportTicketMessage(interaction, assignedTicket, staffActionMatch[1]);
          return interaction.followUp({ content:'Ticket pris en charge.', ephemeral:true });
        }

        if (value === 'release') {
          if (ticket.assigned_to && String(ticket.assigned_to)!==String(interaction.user.id) && !isAdmin(interaction.member)) {
            return interaction.reply({ content:`🔒 Seul l’assigné <@${ticket.assigned_to}> ou un administrateur peut libérer ce ticket.`, ephemeral:true });
          }
          await interaction.deferUpdate();
          const releasedTicket = db.releaseTicket(interaction.channel.id);
          if (!releasedTicket) return interaction.followUp({ content:'Ce ticket est introuvable ou déjà fermé.', ephemeral:true });
          await refreshSupportTicketMessage(interaction, releasedTicket, staffActionMatch[1]);
          return interaction.followUp({ content:'Ticket libéré.', ephemeral:true });
        }

        if (value === 'ask') {
          const current = db.getTicketByChannel(interaction.channel.id);
          if (!current || current.status !== 'open') {
            return interaction.reply({ content:'❌ Ce ticket est introuvable ou déjà fermé.', ephemeral:true });
          }
          await interaction.deferUpdate();
          await interaction.channel.send({
            content:`<@${current.creator_id}> — avez-vous toujours besoin de ce ticket ?`,
            allowedMentions:{users:[current.creator_id]}
          });
          return interaction.followUp({ content:'Message envoyé.', ephemeral:true });
        }

        if (value === 'notify') {
          const ticket = db.getTicketByChannel(interaction.channel.id);
          if (!ticket) return interaction.reply({ content:'Ce salon n’est pas un ticket support géré.', ephemeral:true });
          await interaction.deferUpdate();
          await interaction.channel.send({ content:`🔔 <@${ticket.creator_id}> — le staff vous demande de consulter votre ticket.`, allowedMentions:{users:[ticket.creator_id]} });
          return interaction.followUp({ content:'Créateur notifié.', ephemeral:true });
        }

        if (value === 'lock' || value === 'unlock') {
          const ticket = db.getTicketByChannel(interaction.channel.id);
          if (!ticket || ticket.status !== 'open') return interaction.reply({ content:'❌ Ce ticket est introuvable ou fermé.', ephemeral:true });
          await interaction.deferUpdate();
          const creator = await interaction.guild.members.fetch(ticket.creator_id).catch(() => null);
          if (!creator) return interaction.followUp({ content:'Créateur introuvable sur le serveur.', ephemeral:true });
          try {
            await interaction.channel.permissionOverwrites.edit(creator.id, {
              ViewChannel:true,
              ReadMessageHistory:true,
              SendMessages:value === 'unlock'
            });
            await interaction.channel.send({ embeds:[base(value === 'lock' ? '🔒 Ticket verrouillé' : '🔓 Ticket déverrouillé', value === 'lock' ? `Le ticket a été temporairement verrouillé par ${interaction.user}.` : `Le ticket a été déverrouillé par ${interaction.user}.`)] });
            return interaction.followUp({ content:value === 'lock' ? 'Ticket verrouillé.' : 'Ticket déverrouillé.', ephemeral:true });
          } catch (error) {
            console.error('Erreur verrouillage ticket:', error);
            return interaction.followUp({ content:'Impossible de modifier les permissions du ticket.', ephemeral:true });
          }
        }

        if (value === 'rename') {
          const modal = new ModalBuilder().setCustomId('modal:ticketrename').setTitle('Renommer le ticket');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('Nouveau nom').setPlaceholder('support-probleme-paiement').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(90)
          ));
          return interaction.showModal(modal);
        }

        const modal = new ModalBuilder().setCustomId(`modal:ticketmember:${value}`).setTitle(value==='add'?'Ajouter un membre':'Retirer un membre');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('userId').setLabel('ID de l’utilisateur').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'admin:productselect') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        if (value === 'new') {
          const modal = new ModalBuilder().setCustomId('modal:product:new').setTitle('Ajouter un service');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nom').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('variants').setLabel('Formules et prix').setPlaceholder('1 Jour = 1.60 | 3 Jours = 5 | À vie = 20').setStyle(TextInputStyle.Paragraph).setRequired(false))
          );
          return interaction.showModal(modal);
        }
        const p = db.getProduct(Number(value));
        if (!p) return interaction.reply({ content:'Produit introuvable.', ephemeral:true });
        await interaction.deferUpdate();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`product:edit:${p.id}`).setLabel('Modifier').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`product:toggle:${p.id}`).setLabel(p.active?'Désactiver':'Activer').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`product:delete:${p.id}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger)
        );
        return interaction.editReply({ embeds:[base(`Service — ${p.name}`,  `**Description :** ${p.description || '*Aucune*'}\n**Statut :** \`${p.active?'Actif':'Désactivé'}\`\n\n${p.variants.map(v=>`• **${v.name}** — \`${money(v.price)}\``).join('\n')}`)], components:[row] });
      }

      if (id === 'admin:configselect') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const modal = new ModalBuilder().setCustomId(`modal:config:${value}`).setTitle('Modifier la configuration');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('value').setLabel(value).setStyle(TextInputStyle.Paragraph).setValue(String(db.getConfig(value) ?? '')).setRequired(false)
        ));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('product:')) {
      // handled below only if previous button branch did not return
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      if (id === 'modal:restock:new') {
        if (!isRestockAuthorized(interaction.user.id) || !hasPending(interaction.user.id)) {
          return interaction.reply({ content:'❌ Aucun restock valide n’est en attente.', ephemeral:true });
        }
        const name = interaction.fields.getTextInputValue('name').trim();
        await interaction.deferReply({ ephemeral:true });
        try {
          const result = createService(interaction.user.id, name);
          return interaction.editReply({
            embeds:[restockEmbed('Nouveau stock créé', `🆕 **${result.name}.txt**\n\n> **+${result.added}** ligne(s) ajoutée(s)\n\n🟢 Le nouveau stock est immédiatement disponible pour le Bot 2.`)],
            content:''
          });
        } catch (error) {
          return interaction.editReply({ embeds:[restockEmbed('Création impossible', `❌ ${error.message || 'Une erreur inconnue est survenue.'}`)], content:'' });
        }
      }

      if (id === 'modal:lookup') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const invoice = interaction.fields.getTextInputValue('invoice').trim().toUpperCase();
        const order = db.getOrder(invoice);
        if (!order) return interaction.editReply({ content:'Aucune commande trouvée.' });
        const row = order.status === 'pending'
          ? new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`order:accept:${order.invoice}`).setLabel('Accepter').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`order:refuse:${order.invoice}`).setLabel('Refuser').setStyle(ButtonStyle.Danger)
            )
          : null;
        return interaction.editReply({
          embeds:[base('Commande trouvée',
`**Client :** <@${order.user_id}>\n**Produit :** \`${order.product}\`\n**Option :** \`${order.variant || '—'}\`\n**Paiement :** \`${order.payment_method}\`\n**Prix de base :** \`${money(order.base_price)}\`\n**Frais :** \`${money(order.fee)}\`\n**Montant total :** \`${money(order.total_price)}\`\n**Invoice :** \`${order.invoice}\`\n**Statut :** \`${order.status}\``)],
          components: row ? [row] : []
        });
      }

      if (id === 'modal:maintenance-message') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const message = interaction.fields.getTextInputValue('message').trim();
        if (!message) return interaction.reply({ content:'Le message de maintenance ne peut pas être vide.', ephemeral:true });
        db.setConfig('maintenanceMessage', message);
        return interaction.reply({ content:'Message de maintenance enregistré.', ephemeral:true });
      }

      if (id === 'modal:ticketrename') {
        if (!isStaff(interaction.member)) return interaction.reply({ content:'Action réservée au staff.', ephemeral:true });
        const ticket = db.getTicketByChannel(interaction.channel.id);
        if (!ticket || ticket.status !== 'open') return interaction.reply({ content:'Ce salon n’est pas un ticket ouvert.', ephemeral:true });
        const rawName = interaction.fields.getTextInputValue('name').trim().toLowerCase();
        const cleanName = rawName
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9-_ ]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 90);
        if (!cleanName) return interaction.reply({ content:'Nom invalide. Utilisez des lettres, chiffres, espaces, `-` ou `_`.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        try {
          await interaction.channel.setName(cleanName, `Ticket renommé par ${interaction.user.tag}`);
          await interaction.channel.send({ embeds:[base('✏️ Ticket renommé', `Le salon a été renommé en **#${cleanName}** par ${interaction.user}.`)] });
          return interaction.editReply({ content:`✅ Ticket renommé en **#${cleanName}**.` });
        } catch (error) {
          console.error('Erreur renommage ticket:', error);
          return interaction.editReply({ content:'❌ Impossible de renommer le ticket. Vérifiez que le bot possède **Gérer les salons**.' });
        }
      }

      if (id.startsWith('modal:ticketmember:')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content:'Action réservée au staff.', ephemeral:true });
        const action = id.split(':')[2];
        const userId = interaction.fields.getTextInputValue('userId').trim();
        const ticket = db.getTicketByChannel(interaction.channel.id);
        if (!ticket) return interaction.reply({ content:'Ce salon n’est pas un ticket support géré.', ephemeral:true });
        if (!isSnowflake(userId)) {
          return interaction.reply({ content:'ID utilisateur invalide. Copiez uniquement l’ID Discord numérique de l’utilisateur.', ephemeral:true });
        }

        await interaction.deferReply({ ephemeral:true });

        // Resolve the user first. Passing an arbitrary string to PermissionOverwriteManager
        // throws InvalidType; resolving the GuildMember also guarantees the user belongs to this server.
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) {
          return interaction.editReply({ content:'Utilisateur introuvable sur ce serveur. Vérifiez son ID Discord.' });
        }

        if (action === 'add') {
          try {
            await interaction.channel.permissionOverwrites.edit(member.user, {
              ViewChannel:true,
              SendMessages:true,
              ReadMessageHistory:true
            });
            return interaction.editReply({ content:`Utilisateur ajouté : ${member}` });
          } catch (error) {
            console.error('Erreur ajout membre au ticket:', error);
            return interaction.editReply({ content:'Impossible d’ajouter cet utilisateur au ticket. Vérifiez que le bot possède **Gérer les salons**.' });
          }
        }

        try {
          await interaction.channel.permissionOverwrites.delete(member.user);
          return interaction.editReply({ content:`Utilisateur retiré : ${member}` });
        } catch (error) {
          console.error('Erreur retrait membre du ticket:', error);
          return interaction.editReply({ content:'Impossible de retirer cet utilisateur du ticket. Vérifiez les permissions du bot.' });
        }
      }

      if (id === 'modal:product:new') {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const name = interaction.fields.getTextInputValue('name').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        const raw = interaction.fields.getTextInputValue('variants').trim();
        const variants = raw ? raw.split('|').map(part => {
          const [n,p] = part.split('=');
          return { name:(n||'Standard').trim(), price:Number(String(p||0).replace(',','.')) || 0 };
        }) : [{name:'Standard',price:0}];
        await interaction.deferReply({ ephemeral:true });
        try {
          const product = db.createProduct(name,description,variants);
          return interaction.editReply({ content:`Service **${product.name}** ajouté. Les prix sont enregistrés dans \`data/sicario.json\`.` });
        } catch (error) {
          return interaction.editReply({ content:`Impossible d’ajouter ce produit : ${error.message || 'erreur inconnue'}` });
        }
      }

      if (id.startsWith('modal:config:')) {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        await interaction.deferReply({ ephemeral:true });
        const key = id.split(':')[2];
        const raw = interaction.fields.getTextInputValue('value').trim();
        let value = raw;
        if (key.endsWith('RoleIds')) value = raw.split(',').map(x=>x.trim()).filter(Boolean);
        if (key.endsWith('FeePercent')) value = Number(raw.replace(',','.')) || 0;
        if (key.endsWith('CategoryId') && !raw) value = null;
        db.setConfig(key,value);
        return interaction.editReply({ content:`Configuration **${key}** mise à jour.` });
      }
    }

    // Product button actions and order decisions: intentionally after modal/select routing
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('product:')) {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const [,action,productId] = id.split(':');
        const p = db.getProduct(Number(productId));
        if (!p) return interaction.reply({ content:'Produit introuvable.', ephemeral:true });
        if (action === 'toggle') {
          await interaction.deferReply({ ephemeral:true });
          db.updateProduct(p.id,{active:!p.active});
          return interaction.editReply({ content:`Produit ${p.active?'désactivé':'activé'}.` });
        }
        if (action === 'delete') {
          await interaction.deferReply({ ephemeral:true });
          db.deleteProduct(p.id);
          return interaction.editReply({ content:'Produit supprimé.' });
        }
        if (action === 'edit') {
          const modal = new ModalBuilder().setCustomId(`modal:productedit:${p.id}`).setTitle('Modifier le service');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nom').setStyle(TextInputStyle.Short).setValue(p.name).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(p.description||'').setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('variants').setLabel('Formules et prix').setStyle(TextInputStyle.Paragraph).setPlaceholder('1 Jour = 1.60 | 3 Jours = 5 | À vie = 20').setValue(p.variants.map(v=>`${v.name} = ${v.price}`).join(' | ')).setRequired(false))
          );
          return interaction.showModal(modal);
        }
      }
      if (id.startsWith('order:accept:') || id.startsWith('order:refuse:')) {
        if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
        const [,action,invoice] = id.split(':');
        await interaction.deferUpdate();
        const result = db.processOrder(invoice, action==='accept'?'accepted':'refused', interaction.user.id);
        if (!result.ok) return interaction.editReply({ content:'Cette commande a déjà été traitée ou est introuvable.', embeds:[], components:[] });

        if (action === 'accept') {
          // Seule une commande Générateur active l'accès au Bot 2.
          const product = String(result.order.product || '').trim().toLowerCase();
          const generatorName = String(getConfig('generatorRoleName') || 'Accès Générateur').trim().toLowerCase();

          // Active l'accès Bot 2 pour tout produit correspondant au Générateur.
          // On accepte aussi les anciens noms de produit (ex. "Générateur") pour
          // éviter qu'une commande déjà payée/acceptée soit ignorée à cause d'un nom différent.
          const isGeneratorOrder =
            product === generatorName ||
            product.includes('générateur') ||
            product.includes('generator');

          if (isGeneratorOrder) {
            try {
              const access = grantAccess(result.order.user_id, result.order.variant || 'Lifetime', interaction.user.id);
              console.log(`[ACCESS BOT2] Accès activé pour ${result.order.user_id} — ${access.lifetime ? 'Lifetime' : access.expiry}`);
            } catch (accessError) {
              console.error('Impossible d’activer l’accès au second bot:', accessError);
            }
          }

          // Active les rôles/services associés et envoie les notifications demandées.
          await grantServiceRoleAndNotify(interaction, result.order);
        }

        const channel = await interaction.guild.channels.fetch(result.order.channel_id).catch(()=>null);
        if (channel?.isTextBased()) {
          await channel.send({ embeds:[base(action==='accept'?'Commande acceptée':'Commande refusée',
            action==='accept'
              ? `Votre commande **${result.order.invoice}** a été confirmée par l'équipe **SICARIO SH**.\n\n**Statut :** \`Acceptée\``
              : `Votre commande **${result.order.invoice}** a été refusée.\n\n**Statut :** \`Refusée\``
          )]});
        }
        return interaction.editReply({ embeds:[base('Commande mise à jour', `**Invoice :** \`${invoice}\`\n**Statut :** \`${result.order.status}\`\n**Traité par :** ${interaction.user}`)], components:[] });
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal:productedit:')) {
      if (!adminOnly(interaction)) return interaction.reply({ content:'Action réservée aux administrateurs.', ephemeral:true });
      const productId = Number(interaction.customId.split(':')[2]);
      const name = interaction.fields.getTextInputValue('name').trim();
      const description = interaction.fields.getTextInputValue('description').trim();
      const raw = interaction.fields.getTextInputValue('variants').trim();
      const variants = raw ? raw.split('|').map(part=>{
        const [n,p]=part.split('=');
        return {name:(n||'Standard').trim(),price:Number(String(p||0).replace(',','.'))||0};
      }) : [{name:'Standard',price:0}];
      await interaction.deferReply({ ephemeral:true });
      try {
        const product = db.updateProduct(productId,{name,description,variants});
        if (!product) return interaction.editReply({ content:'Produit introuvable.' });
        return interaction.editReply({ content:`Service **${product.name}** mis à jour. Nom, description et prix sont enregistrés dans \`data/sicario.json\`.` });
      } catch (error) {
        return interaction.editReply({ content:`Impossible de modifier ce produit : ${error.message || 'erreur inconnue'}` });
      }
    }
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable() && !isUnknownInteractionError(error)) {
      const payload = { content:'Une erreur est survenue pendant le traitement de cette action.', ephemeral:true };
      await safeReply(interaction, payload);
    }
  }
};
