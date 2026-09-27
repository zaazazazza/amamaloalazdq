const fs = require('fs');
const path = require('path');

const { getConfig } = require('../database/database');
const { withFileLock } = require('../utils/fileLock');

const stockDir = path.resolve(__dirname, '../../stock');
const pendingDir = path.resolve(__dirname, '../../data/restock-pending');
fs.mkdirSync(stockDir, { recursive: true });
fs.mkdirSync(pendingDir, { recursive: true });

function isAuthorized(userId) {
  return String(userId) === String(getConfig('restockButtonUserId'));
}

function pendingPath(userId) {
  return path.join(pendingDir, `${userId}.txt`);
}

function hasPending(userId) {
  return fs.existsSync(pendingPath(userId));
}

function readPending(userId) {
  const file = pendingPath(userId);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function clearPending(userId) {
  const file = pendingPath(userId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function getStockFiles() {
  return fs.readdirSync(stockDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map(entry => path.basename(entry.name, '.txt'))
    .filter(name => /^[a-z0-9_-]+$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function safeName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(value)) return null;
  return value;
}

function appendToService(userId, service) {
  if (!isAuthorized(userId)) throw new Error('Accès refusé.');
  const name = safeName(service);
  if (!name) throw new Error('Nom de fichier invalide. Utilise uniquement lettres, chiffres, `_` ou `-`.');
  const content = readPending(userId);
  if (content === null) throw new Error('Aucun restock en attente.');

  const file = path.join(stockDir, `${name}.txt`);
  if (!fs.existsSync(file)) throw new Error('Ce fichier de stock n’existe plus.');

  const result = withFileLock(file, () => {
    const incoming = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!incoming.length) throw new Error('Le fichier `.txt` est vide.');

    const existing = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    fs.writeFileSync(file, `${[...existing, ...incoming].join('\n')}\n`, 'utf8');
    return { added: incoming.length, total: existing.length + incoming.length };
  });
  clearPending(userId);
  return { name, ...result };
}

function createService(userId, service) {
  if (!isAuthorized(userId)) throw new Error('Accès refusé.');
  const name = safeName(service);
  if (!name) throw new Error('Nom de fichier invalide. Utilise uniquement lettres, chiffres, `_` ou `-`.');
  const content = readPending(userId);
  if (content === null) throw new Error('Aucun restock en attente.');

  const file = path.join(stockDir, `${name}.txt`);
  if (fs.existsSync(file)) throw new Error(`Le stock **${name}** existe déjà. Choisis-le dans le menu.`);
  const result = withFileLock(file, () => {
    // Un autre restock peut avoir créé le fichier pendant la validation du nom.
    if (fs.existsSync(file)) throw new Error(`Le stock **${name}** existe déjà. Choisis-le dans le menu.`);
    const incoming = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!incoming.length) throw new Error('Le fichier `.txt` est vide.');
    fs.writeFileSync(file, `${incoming.join('\n')}\n`, 'utf8');
    return { added: incoming.length, total: incoming.length };
  });
  clearPending(userId);
  return { name, ...result };
}

module.exports = { isAuthorized, hasPending, getStockFiles, appendToService, createService };
