const fs = require('fs');
const path = require('path');
const https = require('https');
const adminpanel = require('../commands/adminpanel');
const sendpanel = require('../commands/sendpanel');
const db = require('../database/database');
const { getConfig } = db;
const { getStatus: getSupabaseStatus } = require('../services/remoteStore');
const { isAdmin } = require('../utils/permissions');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { base } = require('../utils/embeds');
const { REVIEW_CHANNELS, recordReviewMessage, runReviewScan, isReviewScanRunning } = require('../services/reviewService');

const pendingDir = path.resolve(__dirname, '../../data/restock-pending');
fs.mkdirSync(pendingDir, { recursive: true });

function isAuthorized(userId) {
  return String(userId) === String(getConfig('restockButtonUserId'));
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(downloadFile(response.headers.location, destination));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const stream = fs.createWriteStream(destination);
      response.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', error => {
        stream.destroy();
        reject(error);
      });
    });
    request.on('error', reject);
  });
}

module.exports = async message => {
  if (message.guild && REVIEW_CHANNELS[Object.keys(REVIEW_CHANNELS).find(type => REVIEW_CHANNELS[type] === message.channelId)]) {
    recordReviewMessage(message);
  }
  if (message.author.bot) return;

  // Restock upload flow happens in DM so the uploaded stock file never gets posted publicly.
  if (!message.guild) {
    if (!isAuthorized(message.author.id)) return;
    const attachment = [...message.attachments.values()].find(file => {
      const name = String(file.name || '').toLowerCase();
      return name.endsWith('.txt');
    });
    if (!attachment) return;

    const pendingFile = path.join(pendingDir, `${message.author.id}.txt`);
    try {
      await downloadFile(attachment.url, pendingFile);
      const stats = fs.statSync(pendingFile);
      if (stats.size > 10 * 1024 * 1024) {
        fs.unlinkSync(pendingFile);
        return message.reply('❌ Le fichier est trop volumineux. Limite : 10 Mo.');
      }
      const channelId = getConfig('restockChannelId') || '1483803927223992326';
      const channelLink = `https://discord.com/channels/${getConfig('guildId') || '@me'}/${channelId}`;
      const channel = await message.client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({
          embeds:[base('📥 Restock reçu', `Le fichier de <@${message.author.id}> est prêt à être traité.\n\n> Seul l’utilisateur autorisé pourra ouvrir le gestionnaire et choisir le stock cible.`)],
          components:[new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`restock:open:${message.author.id}`).setLabel('Ouvrir le gestionnaire').setEmoji('📥').setStyle(ButtonStyle.Primary)
          )]
        }).catch(error => console.error('Impossible de publier le gestionnaire de restock:', error));
      }
      return message.reply({
        embeds:[base('✅ Restock reçu', `Ton fichier **.txt** a bien été récupéré.\n\n📍 **Étape suivante :** rends-toi dans <#${channelId}>.\n\nClique ensuite sur **Ouvrir le gestionnaire** pour choisir le stock à alimenter.\n\n🔗 [Ouvrir le salon de restock](${channelLink})`)]
      });
    } catch (error) {
      console.error('Erreur réception restock DM:', error);
      return message.reply('❌ Impossible de récupérer le fichier `.txt`. Réessaie avec un fichier texte valide.');
    }
  }

  db.recordTicketActivity(message.channel.id);

  const command = message.content.trim().toLowerCase();
  if (command === '!avis') {
    if (message.channelId !== REVIEW_CHANNELS.rep) {
      return message.reply(`La commande \`!avis\` est disponible dans <#${REVIEW_CHANNELS.rep}>.`);
    }
    if (isReviewScanRunning()) return message.reply('⏳ Une synchronisation des avis est déjà en cours.');
    const status = await message.reply('🔄 Je parcours l’historique des deux salons d’avis. Cela peut prendre un peu de temps…');
    try {
      const result = await runReviewScan(message.client, {
        onProgress: ({ channelId, pages }) => status.edit(`🔄 Lecture des avis : <#${channelId}> · ${pages * 100}+ messages parcourus…`)
      });
      if (result.busy) return status.edit('⏳ Une synchronisation des avis est déjà en cours.');
      const format = value => value.toLocaleString('fr-FR');
      const lastSync = result.lastSyncAt
        ? `<t:${Math.floor(Date.parse(result.lastSyncAt) / 1000)}:F>`
        : 'Jamais (calcul en direct)';
      return status.edit({
        content:'',
        embeds:[base('⭐ Statistiques des avis',
          `💬 **+REP**\n${format(result.repCount)} avis\n\n` +
          `📸 **Avis photos**\n${format(result.photoCount)} avis\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `⭐ **TOTAL**\n${format(result.total)} avis\n\n` +
          `🕒 **Dernière synchronisation complète :** ${lastSync}`
        )]
      });
    } catch (error) {
      console.error('[AVIS] Calcul impossible:', error);
      return status.edit(`❌ Impossible de parcourir les salons d’avis. Vérifie que le bot peut les voir et lire leur historique. (${error.message})`);
    }
  }

  if (command === '!avis-sync') {
    const isGuildOwner = message.guild.ownerId === message.author.id;
    const hasAdminPermission = message.member?.permissions?.has('Administrator');
    if (!isAdmin(message.member) && !isGuildOwner && !hasAdminPermission) {
      return message.reply('❌ Cette commande est réservée aux administrateurs.');
    }
    if (isReviewScanRunning()) return message.reply('⏳ Une synchronisation des avis est déjà en cours.');
    const status = await message.reply('🔄 Synchronisation complète des deux salons d’avis en cours…');
    try {
      const result = await runReviewScan(message.client, {
        persist: true,
        onProgress: ({ channelId, pages }) => status.edit(`🔄 Synchronisation : <#${channelId}> · ${pages * 100}+ messages parcourus…`)
      });
      if (result.busy) return status.edit('⏳ Une synchronisation des avis est déjà en cours.');
      const format = value => value.toLocaleString('fr-FR');
      const remoteStatus = result.remoteSynced === null
        ? 'Supabase non configuré ; copie locale enregistrée.'
        : result.remoteSynced ? 'Supabase et copie locale mis à jour.' : 'Copie locale mise à jour ; Supabase indisponible ou table absente.';
      return status.edit({
        content:'',
        embeds:[base('🔄 Synchronisation des avis',
          `💬 **+REP :** ${format(result.repCount)}\n` +
          `📸 **Photos :** ${format(result.photoCount)}\n\n` +
          `⭐ **TOTAL :** ${format(result.total)}\n\n` +
          `✅ Synchronisation terminée.\n${remoteStatus}`
        )]
      });
    } catch (error) {
      console.error('[AVIS] Synchronisation impossible:', error);
      return status.edit(`❌ Synchronisation incomplète : ${error.message}`);
    }
  }

  if (command === '!adminpanel') return adminpanel.execute(message);
  if (command === '!sendpanel') return sendpanel.execute(message);

  if (command === '!status') {
    if (!isAdmin(message.member)) {
      return message.reply('Vous n’avez pas la permission de consulter l’état du bot.');
    }

    const dashboard = db.dashboard();
    const pendingOrders = db.getOrders('pending').length;
    const activeProducts = db.getProducts(true).length;
    const allProducts = db.getProducts(false).length;
    const embed = base(
      '📡 SICARIO SH — État du système',
      `Le bot fonctionne correctement et les données locales sont accessibles.\n\n` +
      `**Stockage distant :** \`${getSupabaseStatus() === 'connected' ? 'Supabase connecté' : getSupabaseStatus() === 'error' ? 'Supabase à vérifier' : 'Local uniquement'}\`\n` +
      `**Latence Discord :** \`${Math.max(0, Math.round(message.client.ws.ping))} ms\`\n` +
      `**Produits actifs :** \`${activeProducts}/${allProducts}\`\n` +
      `**Commandes en attente :** \`${pendingOrders}\`\n` +
      `**Commandes acceptées :** \`${dashboard.orders}\`\n` +
      `**Clients enregistrés :** \`${dashboard.uniqueClients}\`\n\n` +
      `> Cette commande ne montre jamais les tokens ni les données privées des clients.`
    );
    return message.reply({ embeds: [embed] });
  }

  // Réinitialise uniquement les tickets/commandes orphelins dont les salons ont disparu.
  if (command === '!resettickets') {
    const isAdmin =
      message.member?.permissions?.has('Administrator') ||
      (getConfig('adminRoleIds') || []).some(id => message.member?.roles?.cache?.has(String(id)));

    if (!isAdmin) return message.reply('❌ Vous devez être administrateur pour utiliser cette commande.');

    try {
      const channels = await message.guild.channels.fetch();
      const result = db.cleanupStaleTickets([...channels.keys()]);
      return message.reply(
        `🧹 **Reset tickets terminé.**\\n\\n` +
        `🎫 Tickets orphelins nettoyés : **${result.ticketsFixed}**\\n` +
        `🛒 Commandes orphelines nettoyées : **${result.ordersFixed}**\\n\\n` +
        `Les tickets encore présents sur le serveur n'ont pas été touchés.`
      );
    } catch (error) {
      console.error('Erreur !resettickets:', error);
      return message.reply('❌ Impossible de nettoyer les anciens tickets.');
    }
  }
};
