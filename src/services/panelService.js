const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { base } = require('../utils/embeds');
const { getConfig } = require('../database/database');

function mainPanel() {
  const maintenanceMode = Boolean(getConfig('maintenanceMode'));
  const maintenanceNotice = maintenanceMode
    ? `### 🚧 Maintenance en cours\n${getConfig('maintenanceMessage')}\n\n`
    : '';
  const embed = base(
    'SICARIO SH',
    `${maintenanceNotice}> **Bienvenue dans l’espace officiel SICARIO SH.**\n> Une interface simple pour accéder au support et aux services.\n\n` +
    `### 🛒 Boutique\nChoisissez une offre, une formule et votre moyen de paiement. Le total est affiché avant validation.\n\n` +
    `### 🛟 Support\nBesoin d’aide ? Consultez la FAQ ou ouvrez directement un ticket avec notre équipe.\n\n` +
    `**Sélectionnez une action ci-dessous pour continuer.**`
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:support').setLabel('Support').setEmoji('🛟').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel:order').setLabel('Commander').setEmoji('🛒').setStyle(ButtonStyle.Primary)
  );
  return { embeds:[embed], components:[row] };
}

function adminPanel() {
  const maintenanceMode = Boolean(getConfig('maintenanceMode'));
  const embed = base(
    'SICARIO SH — Administration',
    `> **Centre de contrôle**\nGérez les commandes, les offres, le support et les restocks depuis ce panneau.\n\n` +
    `**Mode maintenance :** ${maintenanceMode ? '`ACTIVÉ`' : '`Désactivé`'}\n\n` +
    `### 📊 Suivi\n**Dashboard** pour les statistiques • **Lookup** pour retrouver une invoice • **Commandes** pour traiter les demandes\n\n` +
    `### ⚙️ Gestion\n**Offres & Prix** pour la boutique • **Configuration** pour les paramètres • **Add Restock** pour alimenter les stocks\n\n` +
    `🔐 Les actions sensibles restent réservées au staff autorisé.`
  );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:dashboard').setLabel('Dashboard').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin:lookup').setLabel('Lookup').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:orders').setLabel('Commandes').setEmoji('📦').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:products').setLabel('Offres & Prix').setEmoji('🛍️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:config').setLabel('Configuration').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:restock').setLabel('Add Restock').setEmoji('📥').setStyle(ButtonStyle.Success)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:maintenance').setLabel(maintenanceMode ? 'Désactiver maintenance' : 'Activer maintenance').setEmoji(maintenanceMode ? '✅' : '🚧').setStyle(maintenanceMode ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('admin:maintenance-message').setLabel('Message maintenance').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:export-access').setLabel('Exporter accès').setEmoji('📤').setStyle(ButtonStyle.Secondary)
  );
  return { embeds:[embed], components:[row1,row2,row3] };
}
module.exports = { mainPanel, adminPanel };
