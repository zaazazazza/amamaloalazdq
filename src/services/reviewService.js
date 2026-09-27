const fs = require('fs');
const path = require('path');
const db = require('../database/database');
const { queueReviewMessage, queueReviewReplacement } = require('./remoteStore');

const REVIEW_CHANNELS = {
  rep: '1483812593507500137',
  photo: '1483812343585575074'
};
const REVIEW_CHANNEL_IDS = Object.values(REVIEW_CHANNELS);
const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const imageExtensions = /\.(png|jpe?g|webp|gif)$/i;
const ledgerFile = path.resolve(__dirname, '../../data/reviews.jsonl');
fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });

let reviewIndex = null;
let scanRunning = false;
let liveDuringScan = null;

function loadReviewIndex() {
  if (reviewIndex) return reviewIndex;
  reviewIndex = new Map();
  if (!fs.existsSync(ledgerFile)) return reviewIndex;

  for (const line of fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.messageId && REVIEW_CHANNEL_IDS.includes(String(row.channelId)) && ['rep', 'photo'].includes(row.type)) {
        reviewIndex.set(String(row.messageId), row);
      }
    } catch (_) {}
  }
  return reviewIndex;
}

function classifyReview(message) {
  const channelId = String(message.channelId || message.channel?.id || '');
  if (channelId === REVIEW_CHANNELS.rep) {
    const content = String(message.content || '').trim().toLowerCase();
    return /^\+rep(?:\s|$)/.test(content) ? 'rep' : null;
  }

  if (channelId !== REVIEW_CHANNELS.photo) return null;
  const hasImage = [...(message.attachments?.values?.() || [])].some(attachment => {
    const mime = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
    if (imageMimeTypes.has(mime)) return true;
    const filename = String(attachment.name || attachment.url || '').split(/[?#]/)[0];
    return imageExtensions.test(filename);
  });
  return hasImage ? 'photo' : null;
}

function makeReviewRow(message, type = classifyReview(message)) {
  if (!type || !message.id) return null;
  return {
    messageId: String(message.id),
    channelId: String(message.channelId || message.channel?.id),
    type,
    createdAt: new Date(message.createdTimestamp || Date.now()).toISOString()
  };
}

function recordReviewMessage(message) {
  const row = makeReviewRow(message);
  if (!row) return false;
  const index = loadReviewIndex();
  if (index.has(row.messageId)) return false;

  index.set(row.messageId, row);
  try {
    fs.appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (error) {
    console.error('[AVIS] Impossible d’enregistrer l’avis localement:', error.message);
  }
  if (liveDuringScan) liveDuringScan.set(row.messageId, row);
  queueReviewMessage(row);
  return true;
}

function statsFromRows(rows) {
  const repCount = rows.reduce((count, row) => count + (row.type === 'rep' ? 1 : 0), 0);
  const photoCount = rows.reduce((count, row) => count + (row.type === 'photo' ? 1 : 0), 0);
  return { repCount, photoCount, total: repCount + photoCount };
}

async function scanChannel(client, channelId, onProgress, progress) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !channel.messages?.fetch) {
    throw new Error(`Le salon ${channelId} est introuvable ou n’est pas un salon textuel.`);
  }

  let before;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const messages = [...page.values()];
    if (!messages.length) break;

    for (const message of messages) {
      const row = makeReviewRow(message);
      if (row) progress.rows.set(row.messageId, row);
    }

    const oldest = messages.reduce((candidate, message) =>
      !candidate || message.createdTimestamp < candidate.createdTimestamp ? message : candidate, null);
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
    progress.pages++;
    if (progress.pages % 20 === 0 && onProgress) await onProgress({ channelId, pages: progress.pages });
    await new Promise(resolve => setImmediate(resolve));
    if (messages.length < 100) break;
  }
}

async function runReviewScan(client, { onProgress, persist = false } = {}) {
  if (scanRunning) return { busy: true };
  scanRunning = true;
  const startedAt = Date.now();
  liveDuringScan = new Map();
  const progress = { pages: 0, rows: new Map() };

  try {
    for (const channelId of REVIEW_CHANNEL_IDS) {
      await scanChannel(client, channelId, onProgress, progress);
    }

    for (const row of liveDuringScan.values()) {
      if (Date.parse(row.createdAt) >= startedAt) progress.rows.set(row.messageId, row);
    }

    const rows = [...progress.rows.values()];
    let remoteSynced = null;
    let lastSyncAt = db.getConfig('reviewsLastSyncAt') || null;
    if (persist) {
      const nextIndex = new Map(rows.map(row => [row.messageId, row]));
      const tempFile = `${ledgerFile}.tmp`;
      fs.writeFileSync(tempFile, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      fs.renameSync(tempFile, ledgerFile);
      reviewIndex = nextIndex;
      lastSyncAt = new Date().toISOString();
      db.setConfig('reviewsLastSyncAt', lastSyncAt);
      remoteSynced = await queueReviewReplacement(rows, REVIEW_CHANNEL_IDS);
    }

    return { ...statsFromRows(rows), pages: progress.pages, lastSyncAt, remoteSynced };
  } finally {
    liveDuringScan = null;
    scanRunning = false;
  }
}

module.exports = {
  REVIEW_CHANNELS,
  REVIEW_CHANNEL_IDS,
  classifyReview,
  recordReviewMessage,
  runReviewScan,
  isReviewScanRunning: () => scanRunning
};