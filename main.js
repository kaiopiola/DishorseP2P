const {
  app,
  BrowserWindow,
  session,
  desktopCapturer,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Remove o menu superior padrão do Electron (File/Edit/View/...).
Menu.setApplicationMenu(null);

let win = null;
let tray = null;

// ---- Preferências (segundo plano) — persistidas no userData ----------------
const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch (e) {
    return {};
  }
}
function writePrefs(p) {
  try {
    fs.writeFileSync(prefsPath, JSON.stringify(p));
  } catch (e) {}
}
const prefs = readPrefs();
if (prefs.background === undefined) prefs.background = true; // padrão: roda em 2º plano

const startHidden = process.argv.includes('--hidden');

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !startHidden, // iniciado com o Windows: começa oculto na bandeja
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Concede permissões de mídia (mic/câmera) — sem isso, getUserMedia falha.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'videoCapture'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'audioCapture', 'videoCapture'].includes(permission)
  );

  // Fontes de tela/janela para getDisplayMedia().
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        const source = sources.find((s) => s.id === global.__chosenSourceId) || sources[0];
        callback({ video: source, audio: 'loopback' });
      });
    },
    { useSystemPicker: false }
  );
  ipcMain.handle('set-chosen-source', (_e, id) => {
    global.__chosenSourceId = id;
  });

  // ---- Preferências de segundo plano / inicialização (IPC) ----
  ipcMain.handle('get-prefs', () => ({
    background: prefs.background,
    autostart: app.getLoginItemSettings().openAtLogin,
  }));
  ipcMain.handle('set-background', (_e, v) => {
    prefs.background = !!v;
    writePrefs(prefs);
  });
  ipcMain.handle('set-autostart', (_e, v) => {
    app.setLoginItemSettings({ openAtLogin: !!v, args: ['--hidden'] });
  });

  // Fechar a janela minimiza para a bandeja (se "segundo plano" estiver ligado).
  win.on('close', (e) => {
    if (!app.isQuitting && prefs.background) {
      e.preventDefault();
      win.hide();
    }
  });

  // Parâmetros de teste opcionais (só quando definidos explicitamente):
  //   TEST_NICK  -> apelido (pula o gate)
  //   TEST_VOICE -> "spaceId:channelId" para entrar num canal de voz ao abrir
  const parts = [];
  if (process.env.TEST_NICK) parts.push(`nick=${encodeURIComponent(process.env.TEST_NICK)}`);
  if (process.env.TEST_VOICE) parts.push(`joinVoice=${encodeURIComponent(process.env.TEST_VOICE)}`);
  if (process.env.TEST_SEED) parts.push('seed=1');
  if (parts.length) win.loadFile('index.html', { search: parts.join('&') });
  else win.loadFile('index.html');
}

function createTray() {
  const img = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('P2P Chat');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: () => win && win.show() },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.focus();
    else win.show();
  });
}

// Instância única: reabre a janela existente em vez de abrir outra.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow();
    createTray();
  });
}

app.on('window-all-closed', () => {
  // Com a bandeja ativa, a janela é ocultada (não fecha); só sai de fato via "Sair".
  if (process.platform !== 'darwin' && !prefs.background) app.quit();
});

app.on('activate', () => {
  if (win) win.show();
  else createWindow();
});
