const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Concede permissões de mídia (mic/câmera) — sem isso, getUserMedia falha.
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(['media', 'audioCapture', 'videoCapture'].includes(permission));
    }
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) =>
      ['media', 'audioCapture', 'videoCapture'].includes(permission)
  );

  // Fornece as fontes de tela/janela para getDisplayMedia().
  // O renderer chama navigator.mediaDevices.getDisplayMedia(); nós
  // interceptamos e devolvemos a fonte escolhida pelo usuário.
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  });

  // getDisplayMedia precisa de um handler no Electron. O renderer guarda
  // o id da fonte escolhida em uma variável global via IPC antes de chamar.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => {
          const chosenId = global.__chosenSourceId;
          const source =
            sources.find((s) => s.id === chosenId) || sources[0];
          callback({ video: source, audio: 'loopback' });
        });
    },
    { useSystemPicker: false }
  );

  ipcMain.handle('set-chosen-source', (_e, id) => {
    global.__chosenSourceId = id;
  });

  // Sala de teste opcional via env (para rodar 2 instâncias que se acham sozinhas)
  const testRoom = process.env.TEST_ROOM;
  if (testRoom) {
    win.loadFile('index.html', {
      search: `room=${encodeURIComponent(testRoom)}&nick=${encodeURIComponent(
        process.env.TEST_NICK || 'tester'
      )}`,
    });
  } else {
    win.loadFile('index.html');
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
