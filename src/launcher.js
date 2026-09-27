const path = require('path');
const { spawn } = require('child_process');
const { loadEnv } = require('./utils/loadEnv');

loadEnv();

const rootDir = path.resolve(__dirname, '..');
const children = new Map();
let shuttingDown = false;

function startBot(name, script) {
  const child = spawn(process.execPath, [path.join(rootDir, script)], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit'
  });

  children.set(name, child);
  console.log(`[LAUNCHER] ${name} démarré (PID ${child.pid}).`);

  child.on('error', error => {
    console.error(`[LAUNCHER] Impossible de démarrer ${name}:`, error.message);
  });

  child.on('exit', (code, signal) => {
    children.delete(name);
    console.error(
      `[LAUNCHER] ${name} s'est arrêté` +
      (signal ? ` avec le signal ${signal}.` : ` (code ${code ?? 0}).`)
    );

    if (!shuttingDown) {
      shuttingDown = true;
      stopAll(code || 1).catch(error => {
        console.error('[LAUNCHER] Arrêt des autres processus impossible:', error.message);
        process.exit(code || 1);
      });
    }
  });
}

async function stopAll(exitCode = 0) {
  if (children.size === 0) {
    process.exit(exitCode);
  }

  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }

  const deadline = Date.now() + 10_000;
  while (children.size && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGKILL');
  }
  process.exit(exitCode);
}

process.once('SIGINT', () => {
  if (!shuttingDown) {
    shuttingDown = true;
    console.log('[LAUNCHER] Arrêt demandé.');
    stopAll(0);
  }
});

process.once('SIGTERM', () => {
  if (!shuttingDown) {
    shuttingDown = true;
    console.log('[LAUNCHER] Arrêt demandé.');
    stopAll(0);
  }
});

startBot('BOT 1', 'src/index.js');
startBot('BOT 2', 'second-bot/src/index.js');