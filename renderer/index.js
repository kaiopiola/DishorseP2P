import './polyfill.js'; // deve vir ANTES do trystero (ver polyfill.js)
// Estratégia de signaling (todas serverless):
//   trystero/torrent -> trackers BitTorrent via WSS (não validam relógio)
//   trystero/nostr   -> relays nostr (rejeitam eventos com timestamp fora da janela)
//   trystero/mqtt    -> brokers MQTT públicos
import { joinRoom, selfId } from 'trystero/torrent';

const APP_ID = 'webrtc-p2p-chat-demo';
const DEFAULT_ROOM = 'daggerfall';

// ---- Estado -------------------------------------------------------------
let room = null;
let sendChat = null;
let peerCount = 0;
const peerNicks = {}; // peerId -> apelido

// Streams locais de saída, independentes entre si.
let micStream = null; // áudio (voz)
let micEnabled = false;
let camStream = null; // vídeo da câmera
let screenStream = null; // vídeo da tela/janela

// ---- Tiles de vídeo (palco + filmstrip) --------------------------------
// key -> { el, video, kind, isLocal }
const tiles = {};
let focusedKey = null;

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const filmstrip = $('filmstrip');
const placeholder = $('placeholder');
const status = $('status');
const messages = $('messages');
const audioSinks = $('audioSinks');

function updateStatus() {
  if (!room) {
    status.textContent = 'desconectado';
    return;
  }
  status.textContent =
    peerCount > 0
      ? `conectado · ${peerCount} peer(s)`
      : 'conectado · aguardando peers...';
}

const nick = () => $('nick').value || selfId.slice(0, 6);

// ---- Entrar na sala -----------------------------------------------------
function join() {
  const roomName = $('room').value.trim();
  if (!roomName) return;
  if (room) room.leave();
  peerCount = 0;

  console.log('[p2p] selfId=', selfId, 'entrando na sala:', roomName);
  try {
    room = joinRoom({ appId: APP_ID }, roomName);
  } catch (err) {
    console.error('[p2p] falha ao entrar:', err);
    addMessage('erro', 'falha ao entrar: ' + err.message);
    return;
  }
  status.classList.add('on');
  updateStatus();
  enableControls(true);

  // Canal de texto
  const [send, get] = room.makeAction('chat');
  sendChat = send;
  get((msg, peerId) => addMessage(peerNicks[peerId] || peerId.slice(0, 6), msg));

  // Troca de apelidos
  const [sendNick, getNick] = room.makeAction('nick');
  getNick((name, peerId) => {
    peerNicks[peerId] = name;
    // atualiza rótulos de tiles desse peer
    Object.entries(tiles).forEach(([key, t]) => {
      if (key.startsWith(peerId + ':')) {
        t.el.querySelector('.label').textContent = `${name} · ${t.kind}`;
      }
    });
  });

  room.onPeerJoin((peerId) => {
    peerCount++;
    updateStatus();
    console.log('[p2p] peer entrou:', peerId);
    addMessage('sistema', `${peerId.slice(0, 6)} entrou`);
    sendNick(nick());
    // (re)envia todas as minhas mídias ativas ao novo peer, com metadados
    if (micStream) room.addStream(micStream, peerId, { kind: 'mic' });
    if (camStream) room.addStream(camStream, peerId, { kind: 'camera' });
    if (screenStream) room.addStream(screenStream, peerId, { kind: 'screen' });
  });

  room.onPeerLeave((peerId) => {
    peerCount = Math.max(0, peerCount - 1);
    updateStatus();
    console.log('[p2p] peer saiu:', peerId);
    addMessage('sistema', `${peerNicks[peerId] || peerId.slice(0, 6)} saiu`);
    // remove tiles e áudio desse peer
    Object.keys(tiles).forEach((key) => {
      if (key.startsWith(peerId + ':')) removeTile(key);
    });
    const a = document.getElementById('audio-' + peerId);
    if (a) a.remove();
    delete peerNicks[peerId];
  });

  // Streams remotos
  room.onPeerStream((stream, peerId, meta) => {
    const kind = (meta && meta.kind) || 'camera';
    const label = peerNicks[peerId] || peerId.slice(0, 6);

    if (kind === 'mic') {
      // áudio: toca via <audio>, sem tile de vídeo
      let a = document.getElementById('audio-' + peerId);
      if (!a) {
        a = document.createElement('audio');
        a.id = 'audio-' + peerId;
        a.autoplay = true;
        audioSinks.appendChild(a);
      }
      a.srcObject = stream;
      return;
    }

    const key = `${peerId}:${kind}`;
    addOrUpdateTile(key, stream, {
      label: `${label} · ${kind}`,
      kind,
      isLocal: false,
      autoFocus: kind === 'screen',
    });
    // remove o tile se a faixa remota terminar (peer parou de compartilhar)
    stream.getVideoTracks().forEach((t) =>
      t.addEventListener('ended', () => removeTile(key))
    );
  });
}

$('join').onclick = join;

// ---- Chat ---------------------------------------------------------------
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || !sendChat) return;
  sendChat(text);
  addMessage(nick() + ' (você)', text);
  input.value = '';
};

// ---- Microfone (voz) ----------------------------------------------------
async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micEnabled = true;
    if (room) room.addStream(micStream, null, { kind: 'mic' });
    updateMicButton();
  } catch (err) {
    addMessage('erro', 'microfone: ' + err.message);
    updateMicButton();
  }
}

$('btnMic').onclick = () => {
  if (!micStream) return startMic(); // caso a permissão tenha falhado antes
  micEnabled = !micEnabled;
  micStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  updateMicButton();
};

function updateMicButton() {
  const b = $('btnMic');
  if (!micStream) {
    b.textContent = '🎤 Ativar voz';
    b.classList.remove('active', 'muted');
  } else if (micEnabled) {
    b.textContent = '🎤 Microfone';
    b.classList.add('active');
    b.classList.remove('muted');
  } else {
    b.textContent = '🔇 Mudo';
    b.classList.add('muted');
    b.classList.remove('active');
  }
}

// ---- Câmera (toggle independente) --------------------------------------
$('btnCam').onclick = async () => {
  if (camStream) return stopCam();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (room) room.addStream(camStream, null, { kind: 'camera' });
    addOrUpdateTile('local:camera', camStream, {
      label: 'você · câmera',
      kind: 'camera',
      isLocal: true,
      autoFocus: true,
    });
    camStream.getVideoTracks()[0].addEventListener('ended', stopCam);
    $('btnCam').classList.add('active');
  } catch (err) {
    addMessage('erro', 'câmera: ' + err.message);
  }
};

function stopCam() {
  if (!camStream) return;
  if (room) room.removeStream(camStream);
  camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  removeTile('local:camera');
  $('btnCam').classList.remove('active');
}

// ---- Tela / janela (toggle independente) -------------------------------
$('btnScreen').onclick = async () => {
  if (screenStream) return stopScreen();
  const sources = await window.desktop.getSources();
  showSourcePicker(sources, async (id) => {
    await window.desktop.setChosenSource(id);
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      if (room) room.addStream(screenStream, null, { kind: 'screen' });
      addOrUpdateTile('local:screen', screenStream, {
        label: 'você · tela',
        kind: 'screen',
        isLocal: true,
        autoFocus: true,
      });
      screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);
      $('btnScreen').classList.add('active');
    } catch (err) {
      addMessage('erro', 'tela: ' + err.message);
    }
  });
};

function stopScreen() {
  if (!screenStream) return;
  if (room) room.removeStream(screenStream);
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  removeTile('local:screen');
  $('btnScreen').classList.remove('active');
}

// ---- Tiles: criação, foco, layout --------------------------------------
function addOrUpdateTile(key, stream, { label, kind, isLocal, autoFocus }) {
  let t = tiles[key];
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true; // não retornar o próprio áudio
    if (isLocal && kind === 'camera') video.classList.add('mirror');
    // Telas compartilhadas entram em PiP automaticamente quando o app perde foco
    if (kind === 'screen') video.autoPictureInPicture = true;
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.textContent = label;
    // Botão de PiP por tile
    const pip = document.createElement('button');
    pip.className = 'pipbtn';
    pip.textContent = '⧉';
    pip.title = 'Picture-in-Picture';
    pip.onclick = (e) => {
      e.stopPropagation(); // não mexe no foco
      togglePip(video);
    };
    el.append(video, lab, pip);
    el.onclick = () => setFocus(key);
    t = tiles[key] = { el, video, kind, isLocal };
  } else {
    t.el.querySelector('.label').textContent = label;
  }
  t.video.srcObject = stream;

  if (autoFocus || !focusedKey) focusedKey = key;
  layout();
}

function removeTile(key) {
  const t = tiles[key];
  if (!t) return;
  const wasFocused = focusedKey === key;
  t.el.remove();
  delete tiles[key];
  if (wasFocused) focusedKey = Object.keys(tiles)[0] || null;
  layout();
}

function setFocus(key) {
  focusedKey = key;
  layout();
}

// ---- Picture-in-Picture -------------------------------------------------
async function togglePip(video) {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
    } else {
      if (!video.srcObject || video.readyState === 0) return;
      await video.requestPictureInPicture();
    }
  } catch (err) {
    addMessage('erro', 'PiP: ' + err.message);
  }
}

// Botão global: prioriza uma tela compartilhada; senão, o tile em foco.
$('btnPip').onclick = () => {
  const screenKey = Object.keys(tiles).find((k) => tiles[k].kind === 'screen');
  const key = screenKey || focusedKey;
  if (key && tiles[key]) togglePip(tiles[key].video);
};

function layout() {
  const keys = Object.keys(tiles);
  if (!focusedKey || !tiles[focusedKey]) focusedKey = keys[0] || null;

  // esvazia containers (sem destruir os nós de vídeo)
  while (stage.firstChild) stage.removeChild(stage.firstChild);
  filmstrip.innerHTML = '';

  if (!focusedKey) {
    stage.appendChild(placeholder);
    return;
  }

  tiles[focusedKey].el.classList.add('focused');
  stage.appendChild(tiles[focusedKey].el);

  keys
    .filter((k) => k !== focusedKey)
    .forEach((k) => {
      tiles[k].el.classList.remove('focused');
      filmstrip.appendChild(tiles[k].el);
    });
}

// ---- Chat UI ------------------------------------------------------------
function addMessage(from, text) {
  const li = document.createElement('li');
  li.innerHTML = `<b>${escapeHtml(from)}:</b> ${escapeHtml(text)}`;
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---- Seletor de fonte ---------------------------------------------------
function showSourcePicker(sources, onPick) {
  const modal = $('sourceModal');
  const list = $('sourceList');
  list.innerHTML = '';
  sources.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.innerHTML = `<img src="${s.thumbnail}" /><span>${escapeHtml(
      s.name
    )}</span>`;
    item.onclick = () => {
      modal.classList.add('hidden');
      onPick(s.id);
    };
    list.append(item);
  });
  modal.classList.remove('hidden');
}
$('sourceCancel').onclick = () => $('sourceModal').classList.add('hidden');

// ---- Controles ----------------------------------------------------------
function enableControls(on) {
  ['btnMic', 'btnCam', 'btnScreen', 'btnPip', 'chatInput', 'chatSend'].forEach((id) => {
    $(id).disabled = !on;
  });
}

// ---- Auto-join na inicialização ----------------------------------------
const params = new URLSearchParams(location.search);
$('room').value = params.get('room') || DEFAULT_ROOM;
if (params.get('nick')) $('nick').value = params.get('nick');

updateMicButton();
join(); // entra automaticamente na sala padrão (daggerfall)
startMic(); // conectado em voz por padrão
