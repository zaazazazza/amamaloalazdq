const fs = require('fs');
const path = require('path');
const { withFileLock } = require('../../src/utils/fileLock');

const stockDir = path.resolve(__dirname, '../../stock');
fs.mkdirSync(stockDir, { recursive: true });

function serviceNameFromFile(file) {
  return path.basename(file, '.txt');
}

function getServices() {
  return fs.readdirSync(stockDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map(entry => {
      const file = path.join(stockDir, entry.name);
      return { name: serviceNameFromFile(entry.name), file, count: readLines(file).length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function takeOne(service) {
  const safe = String(service || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(safe)) throw new Error('Nom de service invalide.');
  const file = path.join(stockDir, `${safe}.txt`);
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  return withFileLock(file, () => {
    const lines = readLines(file);
    if (!lines.length) return { ok: false, reason: 'empty' };
    const line = lines.shift();
    fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    return { ok: true, line, remaining: lines.length };
  });
}

function restoreOne(service, line) {
  const safe = String(service || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(safe)) throw new Error('Nom de service invalide.');
  const file = path.join(stockDir, `${safe}.txt`);

  return withFileLock(file, () => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, `${String(line).trim()}\n${current}`, 'utf8');
  });
}

module.exports = { getServices, takeOne, restoreOne };
