const fs = require('fs');
const path = require('path');
const {
  queueAccessGrant,
  queueAccessDeletes,
  syncAccessGrants,
  revokedAccessMarker
} = require('./remoteStore');

const dataDir = path.resolve(__dirname, '../../data');
const accessFile = path.join(dataDir, 'access.json');
const backupFile = path.join(dataDir, 'access.json.bak');
fs.mkdirSync(dataDir, { recursive: true });
let cachedData = null;
let primaryFileHealthy = true;
let preferCachedData = false;

function parseAccessFile(file) {
  const json = fs.readFileSync(file, 'utf8')
    .replace(/("added_by"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"');
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Format JSON invalide');
  return value;
}

function load() {
  if (preferCachedData && cachedData) return cachedData;
  if (fs.existsSync(accessFile)) {
    try {
      cachedData = parseAccessFile(accessFile);
      primaryFileHealthy = true;
      return cachedData;
    } catch (error) {
      primaryFileHealthy = false;
      console.error('Impossible de lire data/access.json:', error.message);
    }
  }
  try {
    cachedData = parseAccessFile(backupFile);
    return cachedData;
  } catch (_) {}
  return cachedData || {};
}

function writeLocal(data) {
  cachedData = data;
  const json = JSON.stringify(data, null, 4);
  const temp = `${accessFile}.tmp`;
  fs.writeFileSync(temp, json, 'utf8');
  fs.renameSync(temp, accessFile);
  try { fs.copyFileSync(accessFile, backupFile); } catch (_) {}
  primaryFileHealthy = true;
  preferCachedData = false;
}

function persistLocal(data) {
  cachedData = data;
  try {
    writeLocal(data);
  } catch (error) {
    primaryFileHealthy = false;
    preferCachedData = true;
    console.error('Impossible d’écrire data/access.json; Supabase reste utilisé:', error.message);
  }
}

async function syncFromRemote() {
  const local = load();
  const localUpdatedAt = primaryFileHealthy && fs.existsSync(accessFile) ? fs.statSync(accessFile).mtimeMs : 0;
  const remote = await syncAccessGrants(local, localUpdatedAt);
  if (remote !== null) {
    cachedData = remote;
    persistLocal(remote);
    return remote;
  }
  return load();
}

function getAccess(userId) {
  const data = load();
  const entry = data[String(userId)] || null;
  return entry?.duration_text === revokedAccessMarker ? null : entry;
}

function exportAccessData() {
  return JSON.parse(JSON.stringify(load()));
}

function hasAccess(userId) {
  const entry = getAccess(userId);
  if (!entry) return false;
  if (entry.lifetime === true) return true;
  const expiry = Date.parse(entry.expiry || '');
  return Number.isFinite(expiry) && expiry > Date.now();
}

function grantAccess(userId, durationText, addedBy) {
  const data = load();
  const id = String(userId);
  const now = Date.now();
  const previous = data[id];
  let expiry = now;
  let lifetime = false;
  const text = String(durationText || '').trim();

  if (previous && previous.lifetime === true) {
    // Un accès Lifetime ne doit jamais être raccourci par un nouvel achat limité.
    lifetime = true;
    expiry = null;
  } else if (/lifetime|à\s*vie/i.test(text)) {
    lifetime = true;
    expiry = null;
  } else {
    const match = text.match(/(\d+)\s*(jour|jours|day|days|semaine|semaines|week|weeks|mois|month|months)/i);
    if (!match) throw new Error(`Durée inconnue: ${text}`);
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const days = /semaine|week/.test(unit) ? amount * 7 : /mois|month/.test(unit) ? amount * 30 : amount;
    const base = previous && previous.lifetime !== true && Date.parse(previous.expiry || '') > now
      ? Date.parse(previous.expiry)
      : now;
    expiry = new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
  }

  const record = {
    lifetime,
    expiry,
    added_by: addedBy || null,
    added_at: new Date(now).toISOString(),
    duration_text: text || '**Lifetime**'
  };
  data[id] = record;
  persistLocal(data);
  queueAccessGrant(id, record);
  return record;
}

function cleanupExpired() {
  const data = load();
  const expiredIds = [];
  for (const [id, entry] of Object.entries(data)) {
    if (!entry || entry.lifetime === true || entry.duration_text === revokedAccessMarker) continue;
    const expiry = Date.parse(entry.expiry || '');
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      data[id] = {
        lifetime: false,
        expiry: '1970-01-01T00:00:00.000Z',
        added_by: entry.added_by || null,
        added_at: new Date().toISOString(),
        duration_text: revokedAccessMarker
      };
      expiredIds.push(id);
    }
  }
  if (expiredIds.length) {
    persistLocal(data);
    queueAccessDeletes(expiredIds);
  }
  return data;
}

module.exports = { getAccess, hasAccess, grantAccess, cleanupExpired, syncFromRemote, exportAccessData };
