const { loadEnv } = require('../../src/utils/loadEnv');
loadEnv();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { hasAccess, accessMessage, removeAccess, getAccessInfo, syncFromRemote } = require('./access');
const { getServices, takeOne, restoreOne } = require('./stock');
const { flush } = require('../../src/services/remoteStore');

const ACCESS_GUILD_ID = '1483836729420152984';
const GENERATOR_ROLE_ID = '1483818672559755284';

const token = process.env.BOT2_TOKEN || process.env.SECOND_BOT_TOKEN;
if (!token) {
  console.error('BOT2_TOKEN manquant dans .env');
  process.exit(1);
}

const prefix = '.';

// Cooldown .gen : 10 secondes par utilisateur.
const GEN_COOLDOWN_MS = 10_000;
const genCooldowns = new Map();

// Auto-rôle quand certains comptes mentionnent quelqu'un dans le salon configuré.
const AUTO_ROLE_GUILD_ID = '1483836729420152984';
const AUTO_ROLE_CHANNEL_ID = '1483837541324161094';
const AUTO_ROLE_ROLE_ID = '1483838892032655370';
const AUTO_ROLE_AUTHORS = new Set([
  '1354927760719741010',
  '432071641426821120'
]);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function cleanService(value) {
  return String(value || '').trim().toLowerCase();
}

const COLORS = { primary: 0x5B5BD6, success: 0x57F287, danger: 0xED4245, neutral: 0x2B2D31 };

function botEmbed(title, description, color = COLORS.primary) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'SICARIO SH • Generator' })
    .setTimestamp();
}

function findServiceEmoji(guild, serviceName) {
  const normalized = cleanService(serviceName).replace(/[^a-z0-9_-]/g, '');
  const emoji = guild.emojis.cache.find(e => e.name && cleanService(e.name).replace(/[^a-z0-9_-]/g, '') === normalized);
  if (!emoji) return '📦';
  return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
}

client.once('ready', () => {
  console.log(`[BOT 2] Connecté en tant que ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (!message.guild) return;

  // ============================================================
  // PROTECTION AUTO-RÔLE
  // ============================================================
  // Cette partie est volontairement AVANT le filtre message.author.bot,
  // car les deux IDs autorisés peuvent être des bots.
  // Rien ne peut déclencher l'auto-rôle en dehors de la guild + du salon
  // configurés et seuls les deux auteurs autorisés sont acceptés.
  const isProtectedAutoRoleMessage =
    message.guild.id === AUTO_ROLE_GUILD_ID &&
    message.channel.id === AUTO_ROLE_CHANNEL_ID &&
    AUTO_ROLE_AUTHORS.has(message.author.id);

  if (isProtectedAutoRoleMessage) {
    // On ne traite que les mentions directes d'utilisateurs.
    // @everyone, @here et les rôles ne déclenchent jamais l'ajout.
    const mentionedUsers = [...message.mentions.users.values()]
      .filter(user => !user.bot);

    if (mentionedUsers.length > 0) {
      try {
        const me = message.guild.members.me || await message.guild.members.fetchMe();
        const role = await message.guild.roles.fetch(AUTO_ROLE_ROLE_ID);

        if (!role) {
          console.error(`[AUTO-ROLE] Rôle ${AUTO_ROLE_ROLE_ID} introuvable.`);
        } else if (!me.permissions.has('ManageRoles')) {
          console.error('[AUTO-ROLE] Le Bot 2 n’a pas la permission Manage Roles.');
        } else if (role.managed) {
          console.error(`[AUTO-ROLE] Le rôle ${AUTO_ROLE_ROLE_ID} est géré par une intégration et ne peut pas être attribué.`);
        } else if (role.position >= me.roles.highest.position) {
          console.error(
            `[AUTO-ROLE] Impossible d'ajouter le rôle ${AUTO_ROLE_ROLE_ID}: ` +
            `le rôle du bot doit être placé AU-DESSUS de ce rôle dans Discord.`
          );
        } else {
          for (const user of mentionedUsers) {
            const member = await message.guild.members.fetch(user.id).catch(() => null);
            if (!member) continue;
            if (member.user.bot) continue;
            if (member.roles.cache.has(role.id)) continue;

            await member.roles.add(role, `Auto-rôle: mention autorisée par ${message.author.id}`);
            console.log(`[AUTO-ROLE] ${role.id} ajouté à ${member.id} après mention par ${message.author.id}.`);
          }
        }
      } catch (error) {
        console.error('[AUTO-ROLE] Erreur lors de l’ajout du rôle:', error);
      }
    }
  }

  // Les autres messages provenant de bots ne doivent jamais lancer de commandes.
  if (message.author.bot) return;

  const parts = message.content.trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  if (!command.startsWith(prefix)) return;

  if (command === '.checkaccess' || command === '.removeaccess') {
    // Gestion des accès réservée au staff.
    if (!message.member?.permissions.has('ManageGuild') && !message.member?.permissions.has('Administrator')) {
      return message.reply('❌ Vous n’avez pas la permission d’utiliser cette commande.');
    }

    const target = message.mentions.members.first();
    if (!target) {
      return message.reply(`Utilisation : \`${command} @user\``);
    }

    if (command === '.checkaccess') {
      const entry = getAccessInfo(target.id);
      const hasRole = target.roles.cache.has(GENERATOR_ROLE_ID);
      const active = hasAccess(target.id) || hasRole;

      const expiration = !entry
        ? (hasRole ? 'Accès via rôle Générateur' : 'Aucun')
        : entry.lifetime === true
          ? 'Lifetime'
          : `<t:${Math.floor(entry.expiry / 1000)}:F>`;

      const embed = botEmbed(
        '🔐 Vérification d’accès',
        `👤 **Utilisateur** → ${target}\n` +
        `🎟️ **Accès** → ${active ? '**Générateur**' : '**Aucun**'}\n` +
        `📅 **Expiration** → ${expiration}\n` +
        `🤖 **Bot 2** → ${active ? '**🟢 Actif**' : '**🔴 Inactif**'}\n` +
        `📦 **Rôle Générateur** → ${hasRole ? '**Présent**' : '**Absent**'}\n\n` +
        `${active ? '✅ L’utilisateur peut utiliser la commande `.gen`.' : '❌ Aucun accès générateur actif.'}`,
        active ? COLORS.success : COLORS.danger
      );

      return message.reply({ embeds: [embed] });
    }

    // .removeaccess : retire le rôle + l'entrée d'accès.
    const removedFromDatabase = removeAccess(target.id);
    let removedRole = false;

    if (target.roles.cache.has(GENERATOR_ROLE_ID)) {
      try {
        await target.roles.remove(GENERATOR_ROLE_ID, `Accès supprimé par ${message.author.tag}`);
        removedRole = true;
      } catch (error) {
        console.error(`[ACCESS] Impossible de retirer le rôle de ${target.id}:`, error);
        return message.reply('❌ L’accès a été supprimé de la base de données, mais je n’ai pas pu retirer le rôle Générateur. Vérifiez la hiérarchie des rôles et mes permissions.');
      }
    }

    const embed = botEmbed(
      '🗑️ Accès supprimé',
      `👤 **Utilisateur** → ${target}\n` +
      `🗂️ **Base de données** → ${removedFromDatabase ? '**Supprimé**' : '**Déjà absent**'}\n` +
      `📦 **Rôle Générateur** → ${removedRole ? '**Retiré**' : '**Déjà absent**'}`,
      COLORS.danger
    );

    return message.reply({ embeds: [embed] });
  }

  if (command === '.help' || command === '.aide') {
    const embed = botEmbed(
      '🤖 SICARIO SH — Aide',
      `> **Générateur & gestion des stocks**\n\n` +
      `📦 \`.stock\` — Afficher les disponibilités\n` +
      `🎁 \`.gen <service>\` — Générer une ligne\n` +
      `🔐 \`.checkaccess @user\` — Vérifier un accès *(staff)*\n` +
      `🗑️ \`.removeaccess @user\` — Retirer un accès *(staff)*\n\n` +
      `⏱️ Cooldown génération : **10 secondes**\n` +
      `💬 Les générations sont envoyées en **message privé**.`,
      COLORS.primary
    );
    return message.reply({ embeds: [embed] });
  }

  if (command === '.access' || command === '.acces' || command === '.myaccess') {
    const entry = getAccessInfo(message.author.id);
    const hasGeneratorRole = message.guild.members.cache.get(message.author.id)?.roles.cache.has(GENERATOR_ROLE_ID);
    const active = Boolean(entry || hasGeneratorRole);
    const expiration = !entry
      ? (hasGeneratorRole ? 'Accès via le rôle Générateur' : 'Aucun accès')
      : entry.lifetime
        ? 'Lifetime'
        : `<t:${Math.floor(entry.expiry / 1000)}:F>`;

    return message.reply({
      embeds: [botEmbed(
        '🔐 Mon accès générateur',
        `**Statut :** ${active ? '`🟢 Actif`' : '`🔴 Inactif`'}\n` +
        `**Expiration :** ${expiration}\n\n` +
        (active
          ? 'Vous pouvez utiliser `.gen <service>`.'
          : 'Une commande Générateur acceptée par le staff est nécessaire.'),
        active ? COLORS.success : COLORS.danger
      )]
    });
  }

  if (command === '.stock') {
    const services = getServices();
    const requestedService = cleanService(parts[0]);
    if (requestedService) {
      const service = services.find(item => item.name.toLowerCase() === requestedService);
      if (!service) {
        return message.reply({ embeds: [botEmbed('📦 Service introuvable', `Le service **${requestedService}** n’existe pas dans le stock.\n\nUtilisez \`.stock\` pour afficher les services disponibles.`, COLORS.danger)] });
      }
      return message.reply({ embeds: [botEmbed(
        `📦 Stock — ${service.name}`,
        `${findServiceEmoji(message.guild, service.name)} **Disponibilité :** ${service.count > 0 ? `\`${service.count}\` ligne(s)` : '`Épuisé`'}\n\n` +
        (service.count > 0 ? 'Vous pouvez utiliser `.gen ' + service.name + '`.' : 'Réessayez après le prochain restock.'),
        service.count > 0 ? COLORS.primary : COLORS.danger
      )] });
    }
    const available = services.filter(service => service.count > 0);
    const empty = services.filter(service => service.count === 0);
    const total = services.reduce((sum, service) => sum + service.count, 0);

    const availableLines = available.map(service =>
      `${findServiceEmoji(message.guild, service.name)} **${service.name}** · \`${service.count}\``
    );
    const emptyLines = empty.map(service =>
      `${findServiceEmoji(message.guild, service.name)} **${service.name}** · \`Épuisé\``
    );

    const description =
      `> 📦 **${total}** ligne(s) disponibles au total\n\n` +
      `### 🟢 Disponibles\n${availableLines.length ? availableLines.join('\n') : '*Aucun service disponible.*'}\n\n` +
      `### 🔴 Épuisés\n${emptyLines.length ? emptyLines.join('\n') : '*Aucun service épuisé.*'}\n\n` +
      `*Utilisez \`.gen <service>\` pour générer une ligne.*`;

    const embed = botEmbed('📦 STOCK SICARIO SH', description, available.length ? COLORS.primary : COLORS.danger);
    embed.addFields(
      { name: '🟢 Services actifs', value: `\`${available.length}\``, inline: true },
      { name: '🔴 Services épuisés', value: `\`${empty.length}\``, inline: true },
      { name: '📊 Stock total', value: `\`${total}\``, inline: true }
    );
    return message.reply({ embeds: [embed] });
  }

  if (command === '.gen') {
    const now = Date.now();
    const lastUse = genCooldowns.get(message.author.id) || 0;
    const remainingMs = GEN_COOLDOWN_MS - (now - lastUse);
    if (remainingMs > 0) {
      const remaining = Math.ceil(remainingMs / 1000);
      return message.reply({ embeds: [botEmbed('⏳ Patientez un instant', `Vous pourrez utiliser \`.gen\` à nouveau dans **${remaining}s**.`, COLORS.neutral)] });
    }

    let allowed = hasAccess(message.author.id);
    if (!allowed && message.guild.id === ACCESS_GUILD_ID) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      allowed = Boolean(member?.roles.cache.has(GENERATOR_ROLE_ID));
      if (allowed) console.log(`[ACCESS BOT2] Accès autorisé via rôle Générateur pour ${message.author.id}.`);
    }

    if (!allowed) {
      return message.reply({ embeds: [botEmbed('🔒 Accès refusé', `Vous n’avez pas encore d’accès actif au générateur.\n\n${accessMessage(message.author.id)}`, COLORS.danger)] });
    }

    const service = cleanService(parts[0]);
    if (!service) {
      return message.reply({ embeds: [botEmbed('🎁 Générateur', `Utilisation : \`.gen <service>\`\n\nExemple : \`.gen netflix\`\n\nUtilisez \`.stock\` pour voir les services disponibles.`)] });
    }

    const result = takeOne(service);
    if (!result.ok) {
      if (result.reason === 'missing') {
        return message.reply({ embeds: [botEmbed('📦 Service introuvable', `Le service **${service}** n’existe pas dans le stock.\n\nUtilisez \`.stock\` pour voir les services disponibles.`, COLORS.danger)] });
      }
      return message.reply({ embeds: [botEmbed('📭 Stock épuisé', `Le stock **${service}** est actuellement vide.\n\nRéessayez après le prochain restock.`, COLORS.danger)] });
    }

    try {
      const safeLine = String(result.line).replace(/`/g, '\\`');
      await message.author.send({
        embeds: [botEmbed(
          `🎁 Génération — ${service}`,
          `> Votre génération est prête.\n\n🔐 **Ligne générée**\n\`${safeLine}\`\n\n📦 **Stock restant :** \`${result.remaining}\`\n\n*Ne partagez pas cette ligne publiquement.*`,
          COLORS.success
        )]
      });
    } catch (error) {
      try {
        restoreOne(service, result.line);
      } catch (restoreError) {
        console.error(`[BOT 2] Impossible de remettre la ligne en stock ${service}:`, restoreError);
        return message.reply({ embeds: [botEmbed('⚠️ Intervention nécessaire', 'Le message privé est fermé et la ligne n’a pas pu être remise automatiquement en stock. Prévenez immédiatement le staff.', COLORS.danger)] });
      }
      return message.reply({ embeds: [botEmbed('📨 MP fermé', `Je ne peux pas vous envoyer la génération en message privé.\n\n> Activez vos MP puis réessayez.\n> **La ligne a été remise en stock automatiquement.**`, COLORS.danger)] });
    }

    genCooldowns.set(message.author.id, now);
    return message.reply({ embeds: [botEmbed('✅ Génération réussie', `**Service :** \`${service}\`\n**Stock restant :** \`${result.remaining}\`\n\n📨 La génération vient de vous être envoyée en **message privé**.`, COLORS.success)] });
  }
});

process.on('unhandledRejection', error => console.error('[BOT 2] Unhandled rejection:', error));
process.on('uncaughtException', error => {
  console.error('[BOT 2] Exception non gérée, arrêt du processus:', error);
  process.exit(1);
});

syncFromRemote()
  .then(() => client.login(token))
  .catch(error => {
    console.error('[BOT 2] Synchronisation ou connexion Discord impossible:', error.message);
    process.exit(1);
  });

async function shutdown(signal) {
  console.log(`[BOT 2] Arrêt demandé (${signal}).`);
  await flush();
  client.destroy();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
