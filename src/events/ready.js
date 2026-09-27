const { sendInactiveTicketReminders } = require('../services/ticketService');

module.exports = async client => {
  console.log(`Connecté en tant que ${client.user.tag}`);

  // Répare automatiquement les anciens tickets dont le salon n'existe plus.
  for (const guild of client.guilds.cache.values()) {
    try {
      const channels = await guild.channels.fetch();
      const result = require('../database/database').cleanupStaleTickets([...channels.keys()]);
      if (result.ticketsFixed || result.ordersFixed) {
        console.log(`[TICKETS] Reset automatique : ${result.ticketsFixed} ticket(s), ${result.ordersFixed} commande(s) orpheline(s).`);
      }
    } catch (error) {
      console.error(`[TICKETS] Impossible de vérifier les tickets de ${guild.name}:`, error.message);
    }
  }

  const checkInactiveTickets = () => sendInactiveTicketReminders(client).catch(error => {
    console.error('[TICKETS] Vérification des rappels d’inactivité impossible:', error.message);
  });
  checkInactiveTickets();
  const reminderTimer = setInterval(checkInactiveTickets, 60 * 60 * 1000);
  reminderTimer.unref();

  client.user.setPresence({ activities: [{ name: 'SICARIO SH' }], status: 'online' });
};
