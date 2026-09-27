const { loadEnv } = require('../src/utils/loadEnv');
const { getDocument, getAccessGrants, isConfigured } = require('../src/services/remoteStore');

loadEnv();

if (!isConfigured()) {
  console.error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manque dans .env.');
  process.exit(1);
}

getDocument('sicario')
  .then(async document => {
    if (!document) {
      console.error(
        'La table public.bot_state ou la ligne sicario est introuvable. ' +
        'Exécute d’abord le fichier supabase/schema.sql dans Supabase > SQL Editor, puis relance cette commande.'
      );
      process.exit(1);
    }
    const grants = await getAccessGrants();
    if (grants === null) {
      console.error(
        'La table public.access_grants est inaccessible. ' +
        'Exécute le fichier supabase/schema.sql dans Supabase > SQL Editor.'
      );
      process.exit(1);
    }
    console.log(`Connexion Supabase OK. Dernière mise à jour : ${document.updated_at}`);
    console.log(`Table access_grants OK (${grants.length} accès).`);
  })
  .catch(error => {
    console.error('Connexion Supabase impossible:', error.message);
    process.exit(1);
  });