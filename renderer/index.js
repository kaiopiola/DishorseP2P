import './polyfill.js'; // deve vir ANTES do trystero (ver polyfill.js)
// Estratégia de signaling (todas serverless):
//   trystero/torrent -> trackers BitTorrent via WSS (não validam relógio)
//   trystero/nostr   -> relays nostr (rejeitam eventos com timestamp fora da janela)
//   trystero/mqtt    -> brokers MQTT públicos
import { joinRoom, selfId } from 'trystero/torrent';

const APP_ID = 'webrtc-p2p-chat-demo';
const DEFAULT_ROOM = 'daggerfall';
const SPEAKING_THRESHOLD = 12; // sensibilidade da detecção de voz (0-255)
const SPEAKING_HANGOVER = 300; // ms que a borda verde permanece após a fala

// ---- Estado -------------------------------------------------------------
let room = null;
let sendChat = null;
let peerCount = 0;
const peerNicks = {}; // peerId -> apelido ('local' = eu)

// Streams locais de saída, independentes entre si.
let micStream = null;
let micEnabled = false;
let camStream = null;
let screenStream = null;

// ---- Tiles (bandeja de participantes + telas) --------------------------
// key -> { el, video, avatar?, lab, pip, kind:'participant'|'screen', peerId, stream }
const tiles = {};
let focusedKey = null;

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const stageVideo = $('stageVideo');
const stageAvatar = $('stageAvatar');
const filmstrip = $('filmstrip');
const placeholder = $('placeholder');
const status = $('status');
const messages = $('messages');
const audioSinks = $('audioSinks');

const nick = () => $('nick').value || selfId.slice(0, 6);
const nameOf = (peerId) =>
  peerNicks[peerId] || (peerId === 'local' ? nick() : peerId.slice(0, 6));
const initialOf = (s) => ((s || '?').trim().charAt(0) || '?').toUpperCase();
const hueOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};

function updateStatus() {
  if (!room) return (status.textContent = 'desconectado');
  status.textContent =
    peerCount > 0
      ? `conectado · ${peerCount} peer(s)`
      : 'conectado · aguardando peers...';
}

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

  ensureParticipant('local'); // meu próprio tile
  focusedKey = 'local';
  renderStage();

  const [send, get] = room.makeAction('chat');
  sendChat = send;
  get((msg, peerId) => addMessage(nameOf(peerId), msg));

  const [sendNick, getNick] = room.makeAction('nick');
  getNick((name, peerId) => {
    peerNicks[peerId] = name;
    ensureParticipant(peerId);
    refreshLabels(peerId);
  });

  room.onPeerJoin((peerId) => {
    peerCount++;
    updateStatus();
    console.log('[p2p] peer entrou:', peerId);
    addMessage('sistema', `${peerId.slice(0, 6)} entrou`);
    ensureParticipant(peerId);
    sendNick(nick());
    if (micStream) room.addStream(micStream, peerId, { kind: 'mic' });
    if (camStream) room.addStream(camStream, peerId, { kind: 'camera' });
    if (screenStream) room.addStream(screenStream, peerId, { kind: 'screen' });
  });

  room.onPeerLeave((peerId) => {
    peerCount = Math.max(0, peerCount - 1);
    updateStatus();
    console.log('[p2p] peer saiu:', peerId);
    addMessage('sistema', `${nameOf(peerId)} saiu`);
    detachVAD(peerId);
    removeTile(peerId); // participante
    removeTile(peerId + ':screen'); // tela dele, se houver
    const a = document.getElementById('audio-' + peerId);
    if (a) a.remove();
    delete peerNicks[peerId];
    renderStage();
  });

  room.onPeerStream((stream, peerId, meta) => {
    const kind = (meta && meta.kind) || 'camera';
    if (kind === 'mic') {
      let a = document.getElementById('audio-' + peerId);
      if (!a) {
        a = document.createElement('audio');
        a.id = 'audio-' + peerId;
        a.autoplay = true;
        audioSinks.appendChild(a);
      }
      a.srcObject = stream;
      ensureParticipant(peerId);
      attachVAD(peerId, stream); // acende a borda verde quando falar
    } else if (kind === 'screen') {
      addScreenTile(peerId, stream);
      onVideoEnded(stream, () => removeTile(peerId + ':screen'));
    } else {
      setParticipantCamera(peerId, stream);
      onVideoEnded(stream, () => setParticipantCamera(peerId, null));
    }
  });
}

$('join').onclick = join;
$('nick').addEventListener('input', () => {
  refreshLabels('local');
  renderStage();
});

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
    ensureParticipant('local');
    attachVAD('local', micStream);
    updateMicButton();
  } catch (err) {
    addMessage('erro', 'microfone: ' + err.message);
    updateMicButton();
  }
}

$('btnMic').onclick = () => {
  if (!micStream) return startMic();
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
    setParticipantCamera('local', camStream);
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
  setParticipantCamera('local', null);
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
      addScreenTile('local', screenStream);
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

// ---- Detecção de voz (VAD) ---------------------------------------------
let audioCtx = null;
const vadCleanups = {}; // peerId -> cleanup

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// autoplay: garante que o AudioContext rode após qualquer interação
document.addEventListener('pointerdown', () => audioCtx && audioCtx.resume());

function attachVAD(peerId, stream) {
  if (!stream.getAudioTracks().length) return;
  detachVAD(peerId);
  const ctx = getAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf;
  let lastSpoke = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;
    const now = performance.now();
    if (avg > SPEAKING_THRESHOLD) lastSpoke = now;
    setSpeaking(peerId, now - lastSpoke < SPEAKING_HANGOVER);
    raf = requestAnimationFrame(tick);
  };
  tick();
  vadCleanups[peerId] = () => {
    running = false;
    cancelAnimationFrame(raf);
    try {
      src.disconnect();
    } catch (e) {}
    setSpeaking(peerId, false);
  };
}

function detachVAD(peerId) {
  if (vadCleanups[peerId]) {
    vadCleanups[peerId]();
    delete vadCleanups[peerId];
  }
}

function setSpeaking(peerId, on) {
  const t = tiles[peerId];
  if (t) t.el.classList.toggle('speaking', on);
  // reflete no palco se este participante estiver em foco
  if (focusedKey === peerId) stage.classList.toggle('speaking', on);
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

$('btnPip').onclick = () => {
  const screenKey = Object.keys(tiles).find((k) => tiles[k].kind === 'screen');
  if (screenKey) setFocus(screenKey);
  togglePip(stageVideo);
};

// ---- Tiles: participantes ----------------------------------------------
function ensureParticipant(peerId) {
  let t = tiles[peerId];
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile participant';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.display = 'none';
    if (peerId === 'local') video.classList.add('mirror');
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const lab = document.createElement('span');
    lab.className = 'label';
    const pip = document.createElement('button');
    pip.className = 'pipbtn';
    pip.textContent = '⧉';
    pip.title = 'Picture-in-Picture';
    pip.style.display = 'none';
    pip.onclick = (e) => {
      e.stopPropagation();
      togglePip(video);
    };
    el.append(video, avatar, lab, pip);
    el.onclick = () => setFocus(peerId);
    t = tiles[peerId] = {
      el,
      video,
      avatar,
      lab,
      pip,
      kind: 'participant',
      peerId,
      stream: null,
    };
    filmstrip.appendChild(el);
  }
  refreshLabels(peerId);
  return t;
}

function setParticipantCamera(peerId, stream) {
  const t = ensureParticipant(peerId);
  t.stream = stream || null;
  if (stream) {
    t.video.srcObject = stream;
    t.video.style.display = 'block';
    t.avatar.style.display = 'none';
    t.pip.style.display = '';
  } else {
    t.video.srcObject = null;
    t.video.style.display = 'none';
    t.avatar.style.display = 'flex';
    t.pip.style.display = 'none';
  }
  renderStage();
}

// ---- Tiles: tela --------------------------------------------------------
function addScreenTile(peerId, stream) {
  const key = peerId + ':screen';
  let t = tiles[key];
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile screen';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.autoPictureInPicture = true; // auto-PiP ao perder foco da janela
    const lab = document.createElement('span');
    lab.className = 'label';
    const pip = document.createElement('button');
    pip.className = 'pipbtn';
    pip.textContent = '⧉';
    pip.title = 'Picture-in-Picture';
    pip.onclick = (e) => {
      e.stopPropagation();
      togglePip(video);
    };
    el.append(video, lab, pip);
    el.onclick = () => setFocus(key);
    t = tiles[key] = { el, video, lab, pip, kind: 'screen', peerId, stream };
    filmstrip.appendChild(el);
  }
  t.stream = stream;
  t.video.srcObject = stream;
  t.lab.textContent = `${nameOf(peerId)} · tela`;
  setFocus(key); // telas ganham foco automático
}

// ---- Rótulos e avatares -------------------------------------------------
function refreshLabels(peerId) {
  const t = tiles[peerId];
  if (t && t.kind === 'participant') {
    const name = nameOf(peerId);
    t.lab.textContent = peerId === 'local' ? `${name} (você)` : name;
    t.avatar.textContent = initialOf(name);
    t.avatar.style.background = `hsl(${hueOf(peerId)} 55% 45%)`;
  }
  const st = tiles[peerId + ':screen'];
  if (st) st.lab.textContent = `${nameOf(peerId)} · tela`;
}

// ---- Foco / palco -------------------------------------------------------
function setFocus(key) {
  focusedKey = key;
  renderStage();
}

function removeTile(key) {
  const t = tiles[key];
  if (!t) return;
  t.el.remove();
  delete tiles[key];
  if (focusedKey === key) focusedKey = null;
}

function renderStage() {
  const keys = Object.keys(tiles);
  if (!focusedKey || !tiles[focusedKey]) {
    focusedKey =
      keys.find((k) => tiles[k].kind === 'screen') ||
      keys.find((k) => tiles[k].stream) ||
      keys[0] ||
      null;
  }
  keys.forEach((k) => tiles[k].el.classList.toggle('focused', k === focusedKey));

  const t = focusedKey && tiles[focusedKey];
  if (!t) {
    stageVideo.style.display = 'none';
    stageAvatar.style.display = 'none';
    placeholder.style.display = '';
    stage.classList.remove('speaking');
    return;
  }
  placeholder.style.display = 'none';
  // reflete estado de fala do foco
  stage.classList.toggle('speaking', t.el.classList.contains('speaking'));

  if (t.stream) {
    stageVideo.srcObject = t.stream;
    stageVideo.classList.toggle(
      'mirror',
      t.kind === 'participant' && t.peerId === 'local'
    );
    stageVideo.style.display = 'block';
    stageAvatar.style.display = 'none';
  } else {
    stageAvatar.textContent = initialOf(nameOf(t.peerId));
    stageAvatar.style.background = `hsl(${hueOf(t.peerId)} 55% 45%)`;
    stageVideo.style.display = 'none';
    stageAvatar.style.display = 'flex';
  }
}

// ---- Utilitário: detectar fim de faixa de vídeo remota ------------------
function onVideoEnded(stream, cb) {
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', cb));
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
  ['btnMic', 'btnCam', 'btnScreen', 'btnPip', 'chatInput', 'chatSend'].forEach(
    (id) => ($(id).disabled = !on)
  );
}

// ---- Auto-join na inicialização ----------------------------------------
const params = new URLSearchParams(location.search);
$('room').value = params.get('room') || DEFAULT_ROOM;
if (params.get('nick')) $('nick').value = params.get('nick');

updateMicButton();
join();
startMic();
