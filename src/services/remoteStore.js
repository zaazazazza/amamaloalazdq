const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../utils/loadEnv');

loadEnv();

const stateTable = 'bot_state';
const accessTable = 'access_grants';
const reviewTable = 'review_messages';
const revokedAccessMarker = '__revoked__';
let warned = false;
let queue = Promise.resolve();
let connectionState = isConfigured() ? 'configured' : 'disabled';

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function client() {
  if (!isConfigured()) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function warn(error) {
  connectionState = 'error';
  if (warned) return;
  warned = true;
  console.error(
    '[SUPABASE] Synchronisation indisponible. Le bot continue avec les fichiers locaux:',
    error?.message || error
  );
}

async function getDocument(key) {
  const supabase = client();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(stateTable)
    .select('value, updated_at')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    warn(error);
    return null;
  }
  connectionState = 'connected';
  return data || null;
}

async function putDocument(key, value) {
  const supabase = client();
  if (!supabase) return false;

  const { error } = await supabase
    .from(stateTable)
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) {
    warn(error);
    return false;
  }
  connectionState = 'connected';
  return true;
}

function queueDocument(key, value) {
  if (!isConfigured()) return queue;

  // Copie immédiate : une mutation locale ultérieure ne doit pas changer la
  // valeur qui est déjà en attente d’envoi.
  const snapshot = JSON.parse(JSON.stringify(value));
  queue = queue
    .then(() => putDocument(key, snapshot))
    .catch(error => {
      warn(error);
      return false;
    });
  return queue;
}

function writeLocalJson(file, value) {
  const tempFile = `${file}.remote.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFile, file);
}

async function syncJsonFile({ key, file, defaultValue }) {
  if (!isConfigured()) return null;

  const remote = await getDocument(key);
  let local = defaultValue;
  let localExists = false;

  try {
    local = JSON.parse(fs.readFileSync(file, 'utf8'));
    localExists = true;
  } catch (_) {
    // Le fichier local peut ne pas exister sur une nouvelle installation.
  }

  if (!remote) {
    if (localExists) queueDocument(key, local);
    return null;
  }

  const remoteTime = Date.parse(remote.updated_at || '');
  const localTime = localExists ? fs.statSync(file).mtimeMs : 0;

  // Si le fichier local a changé après la dernière sauvegarde distante, on
  // conserve la version locale et on la pousse. Sinon, Supabase devient la
  // source de vérité pour récupérer une perte locale.
  if (localExists && Number.isFinite(remoteTime) && localTime > remoteTime + 1000) {
    queueDocument(key, local);
    return null;
  }

  writeLocalJson(file, remote.value);
  return remote.value;
}

function toTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function toAccessRow(userId, entry) {
  return {
    discord_user_id: String(userId),
    lifetime: entry?.lifetime === true || entry?.lifetime === 'true',
    expires_at: toTimestamp(entry?.expiry),
    added_by: entry?.added_by == null ? null : String(entry.added_by),
    added_at: toTimestamp(entry?.added_at),
    duration_text: entry?.duration_text || null
  };
}

function fromAccessRow(row) {
  return {
    lifetime: row.lifetime === true,
    expiry: row.expires_at || null,
    added_by: row.added_by,
    added_at: row.added_at,
    duration_text: row.duration_text || (row.lifetime ? '**Lifetime**' : null)
  };
}

function activeAccessData(data) {
  return Object.fromEntries(
    Object.entries(data || {}).filter(([, entry]) => entry?.duration_text !== revokedAccessMarker)
  );
}

async function getAccessGrants() {
  const supabase = client();
  if (!supabase) return null;

  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from(accessTable)
      .select('discord_user_id, lifetime, expires_at, added_by, added_at, duration_text')
      .order('discord_user_id')
      .range(offset, offset + 999);

    if (error) {
      warn(error);
      return null;
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  connectionState = 'connected';
  return rows;
}

async function putAccessGrants(rows) {
  const supabase = client();
  if (!supabase) return false;
  if (!rows.length) return true;

  const { error } = await supabase
    .from(accessTable)
    .upsert(rows, { onConflict: 'discord_user_id' });

  if (error) {
    warn(error);
    return false;
  }
  connectionState = 'connected';
  return true;
}

async function syncAccessGrants(localData, localUpdatedAt = 0) {
  const rows = await getAccessGrants();
  if (rows === null) return null;

  if (rows.length === 0) {
    const legacy = await getDocument('access');
    const legacyTime = Date.parse(legacy?.updated_at || '');
    const localIsNewer = Number.isFinite(legacyTime) && localUpdatedAt > legacyTime + 1000;
    const seedData = legacy?.value && !localIsNewer ? legacy.value : localData;
    const localRows = Object.entries(seedData || {}).map(([userId, entry]) => toAccessRow(userId, entry));
    if (localRows.length && !(await putAccessGrants(localRows))) return localData;
    return activeAccessData(seedData);
  }

  const merged = Object.fromEntries(rows.map(row => [String(row.discord_user_id), fromAccessRow(row)]));
  const localRows = [];
  for (const [userId, entry] of Object.entries(localData || {})) {
    const remoteEntry = merged[userId];
    const localTime = Date.parse(entry?.added_at || '');
    const remoteTime = Date.parse(remoteEntry?.added_at || '');
    if (!remoteEntry || (Number.isFinite(localTime) && (!Number.isFinite(remoteTime) || localTime > remoteTime))) {
      merged[userId] = entry;
      localRows.push(toAccessRow(userId, entry));
    }
  }
  if (localRows.length) await putAccessGrants(localRows);
  return activeAccessData(merged);
}

function queueAccessGrant(userId, entry) {
  if (!isConfigured()) return queue;
  const row = toAccessRow(userId, entry);
  queue = queue
    .then(() => putAccessGrants([row]))
    .catch(error => {
      warn(error);
      return false;
    });
  return queue;
}

function queueAccessDelete(userId) {
  if (!isConfigured()) return queue;
  return queueAccessGrant(userId, {
    lifetime: false,
    expiry: '1970-01-01T00:00:00.000Z',
    added_by: null,
    added_at: new Date().toISOString(),
    duration_text: revokedAccessMarker
  });
}

function queueAccessDeletes(userIds) {
  if (!isConfigured() || !userIds.length) return queue;
  const addedAt = new Date().toISOString();
  const rows = userIds.map(userId => toAccessRow(userId, {
    lifetime: false,
    expiry: '1970-01-01T00:00:00.000Z',
    added_at: addedAt,
    duration_text: revokedAccessMarker
  }));
  queue = queue
    .then(() => putAccessGrants(rows))
    .catch(error => {
      warn(error);
      return false;
    });
  return queue;
}

async function putReviewRows(rows) {
  const supabase = client();
  if (!supabase) return false;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await supabase
      .from(reviewTable)
      .upsert(rows.slice(offset, offset + 500), { onConflict: 'message_id' });
    if (error) {
      warn(error);
      return false;
    }
  }
  connectionState = 'connected';
  return true;
}

function toReviewRow(row) {
  return {
    message_id: String(row.messageId),
    channel_id: String(row.channelId),
    type: row.type,
    created_at: row.createdAt
  };
}

function queueReviewMessage(row) {
  if (!isConfigured()) return queue;
  const snapshot = toReviewRow(row);
  queue = queue
    .then(() => putReviewRows([snapshot]))
    .catch(error => {
      warn(error);
      return false;
    });
  return queue;
}

function queueReviewReplacement(rows, channelIds) {
  if (!isConfigured()) return Promise.resolve(false);
  const snapshot = rows.map(toReviewRow);
  const channels = channelIds.map(String);
  queue = queue
    .then(async () => {
      const supabase = client();
      if (!supabase) return false;
      if (!(await putReviewRows(snapshot))) return false;

      const existingIds = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase
          .from(reviewTable)
          .select('message_id')
          .in('channel_id', channels)
          .order('message_id')
          .range(offset, offset + 999);
        if (error) {
          warn(error);
          return false;
        }
        existingIds.push(...(data || []).map(row => String(row.message_id)));
        if (!data || data.length < 1000) break;
      }

      const currentIds = new Set(snapshot.map(row => row.message_id));
      const staleIds = existingIds.filter(messageId => !currentIds.has(messageId));
      for (let offset = 0; offset < staleIds.length; offset += 500) {
        const { error } = await supabase.from(reviewTable).delete().in('message_id', staleIds.slice(offset, offset + 500));
        if (error) {
          warn(error);
          return false;
        }
      }
      return true;
    })
    .catch(error => {
      warn(error);
      return false;
    });
  return queue;
}

function flush() {
  return queue;
}

module.exports = {
  isConfigured,
  getStatus: () => connectionState,
  getDocument,
  putDocument,
  queueDocument,
  syncJsonFile,
  getAccessGrants,
  syncAccessGrants,
  revokedAccessMarker,
  queueAccessGrant,
  queueAccessDelete,
  queueAccessDeletes,
  queueReviewMessage,
  queueReviewReplacement,
  flush
};