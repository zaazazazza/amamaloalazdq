const fs = require('fs');
const path = require('path');
const {
  queueAccessDelete,
  syncAccessGrants,
  revokedAccessMarker
} = require('../../src/services/remoteStore');

const accessFile = path.resolve(__dirname, '../../data/access.json');
const legacyAccessFile = path.resolve(__dirname, '../data/access.json');
const backupFile = path.resolve(__dirname, '../../data/access.json.bak');
let cachedData = null;
let primaryFileHealthy = true;
let preferCachedData = false;

function readFile(file) {
  try {
    const json = fs.readFileSync(file, 'utf8')
      .replace(/("added_by"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"');
    const data = JSON.parse(json);
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return null;
  }
}

function readAccess() {
  if (preferCachedData && cachedData) return cachedData;
  const data = readFile(accessFile);
  if (data) {
    cachedData = data;
    primaryFileHealthy = true;
    return data;
  }
  primaryFileHealthy = false;
  const backup = readFile(backupFile);
  if (backup) {
    cachedData = backup;
    return backup;
  }
  const legacy = readFile(legacyAccessFile);
  if (legacy) {
    cachedData = legacy;
    return legacy;
  }
  console.error('Impossible de lire les fichiers d’accès:', accessFile);
  return cachedData || {};
}

function writeAccess(data) {
  cachedData = data;
  try {
    fs.mkdirSync(path.dirname(accessFile), { recursive: true });
    const tempFile = `${accessFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, accessFile);
    try { fs.copyFileSync(accessFile, backupFile); } catch (_) {}
    primaryFileHealthy = true;
    preferCachedData = false;
  } catch (error) {
    primaryFileHealthy = false;
    preferCachedData = true;
    console.error('Impossible d’écrire data/access.json; Supabase reste utilisé:', error.message);
  }
}

function getEntry(userId) {
  const id = String(userId);
  const data = readAccess();
  const entry = data[id] || null;
  return entry?.duration_text === revokedAccessMarker ? null : entry;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.duration_text === revokedAccessMarker) return null;
  if (entry.lifetime === true || entry.lifetime === 'true') return { ...entry, lifetime: true };
  const expiry = Date.parse(entry.expiry || '');
  if (!Number.isFinite(expiry)) return null;
  return { ...entry, lifetime: false, expiry };
}

function hasAccess(userId) {
  const entry = normalizeEntry(getEntry(userId));
  if (!entry) return false;
  if (entry.lifetime === true) return true;
  return entry.expiry > Date.now();
}

function removeAccess(userId) {
  const data = readAccess();
  const id = String(userId);
  const existed = Object.prototype.hasOwnProperty.call(data, id) && data[id]?.duration_text !== revokedAccessMarker;
  if (existed) {
    data[id] = {
      lifetime: false,
      expiry: '1970-01-01T00:00:00.000Z',
      added_by: null,
      added_at: new Date().toISOString(),
      duration_text: revokedAccessMarker
    };
    writeAccess(data);
    queueAccessDelete(id);
  }
  return existed;
}

function getAccessInfo(userId) {
  return normalizeEntry(getEntry(userId));
}

async function syncFromRemote() {
  const local = readAccess();
  const localUpdatedAt = primaryFileHealthy && fs.existsSync(accessFile) ? fs.statSync(accessFile).mtimeMs : 0;
  const remote = await syncAccessGrants(local, localUpdatedAt);
  if (remote !== null) {
    writeAccess(remote);
    return remote;
  }
  return readAccess();
}

function accessMessage(userId) {
  const entry = normalizeEntry(getEntry(userId));
  if (!entry) return 'Vous n’avez aucun accès actif. Une commande payée et acceptée par le Bot 1 est nécessaire.';
  if (entry.lifetime === true) return 'Votre accès est **Lifetime**.';
  if (entry.expiry <= Date.now()) return 'Votre accès a expiré. Vous devez renouveler votre commande.';
  return `Votre accès est actif jusqu’au <t:${Math.floor(entry.expiry / 1000)}:F>.`;
}

module.exports = { hasAccess, accessMessage, removeAccess, getAccessInfo, syncFromRemote };
