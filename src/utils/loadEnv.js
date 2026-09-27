const fs = require('fs');
const path = require('path');

/**
 * Charge un fichier .env sans dépendance externe.
 *
 * Les chemins de données du projet sont déjà relatifs au dossier du bot ;
 * le chargement de l'environnement suit la même règle pour que le démarrage
 * fonctionne aussi lorsqu'il est lancé par systemd ou PM2.
 */
function loadEnv() {
  const envPath = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) process.env[key] = value;
  }
}

module.exports = { loadEnv };