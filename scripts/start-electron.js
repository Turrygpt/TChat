const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');
const projectRoot = path.join(__dirname, '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [projectRoot], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron завершён сигналом: ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 0);
});
