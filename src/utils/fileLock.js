const fs = require('fs');

const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);

function acquireFileLock(file, timeoutMs = 5000) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // mkdir est atomique entre les deux processus Node.
      fs.mkdirSync(lockPath);
      return lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > 30_000) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (_) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Le fichier ${file} est temporairement verrouillé.`);
      }

      Atomics.wait(sleepView, 0, 0, 25);
    }
  }
}

function withFileLock(file, callback) {
  const lockPath = acquireFileLock(file);
  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

module.exports = { withFileLock };