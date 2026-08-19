import './polyfill.js'; // deve vir ANTES do trystero
import { joinRoom, selfId } from 'trystero/torrent';
import * as store from './store.js';

const APP_ID = 'webrtc-p2p-chat-demo';
const SPEAKING_THRESHOLD = 12;
const SPEAKING_HANGOVER = 300;

const $ = (id) => document.getElementById(id);

// ---- Estado -------------------------------------------------------------
let spaces = store.loadSpaces();
let currentSpaceId = spaces[0].id;
let viewKey = null; // canal em exibição ("spaceId:channelId")

// texto
let textRoom = null;
let textRoomKey = null;
let sendChat = null;
const textPeerNicks = {};
const messagesByChannel = {}; // key -> [{from,text,sys}]

// voz (persiste enquanto navego em canais de texto)
let voice = null; // { key, spaceId, channelId, name, room }
let voiceParticipants = {}; // peerId('local') -> nick

// mídia local
let micStream = null;
let micEnabled = false;
let camStream = null;
let screenStream = null;

// tiles de vídeo
const tiles = {};
let focusedKey = null;

// VAD
let audioCtx = null;
const vadCleanups = {};
const levels = {};

// ---- Helpers ------------------------------------------------------------
const key = (s, c) => `${s}:${c}`;
const parseKey = (k) => ({ spaceId: k.split(':')[0], channelId: k.split(':')[1] });
const getSpace = (id) => spaces.find((s) => s.id === id);
const getChannel = (sid, cid) => getSpace(sid)?.channels.find((c) => c.id === cid);
const myNick = () => store.getNick() || selfId.slice(0, 6);
const nickOf = (pid) => (pid === 'local' ? myNick() : voiceParticipants[pid] || pid.slice(0, 6));
const initialOf = (s) => ((s || '?').trim().charAt(0) || '?').toUpperCase();
const hueOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
function pushSys(text) {
  console.log('[sys]', text);
  if (textRoomKey) pushMsg(textRoomKey, 'sistema', text, true);
}

// ---- DOM refs -----------------------------------------------------------
const rail = $('rail');
const channelList = $('channelList');
const spaceNameEl = $('spaceName');
const stage = $('stage');
const stageVideo = $('stageVideo');
const stageAvatar = $('stageAvatar');
const filmstrip = $('filmstrip');
const placeholder = $('placeholder');
const messages = $('messages');
const audioSinks = $('audioSinks');
const textView = $('textView');
const voiceView = $('voiceView');
const emptyView = $('emptyView');

// ========================================================================
//  RAIL DE SERVIDORES
// ========================================================================
function renderRail() {
  rail.innerHTML = '';
  spaces.forEach((sp) => {
    const b = document.createElement('button');
    b.className = 'server-icon' + (sp.id === currentSpaceId ? ' active' : '');
    b.textContent = sp.icon || initialOf(sp.name);
    b.title = sp.name;
    b.onclick = () => selectSpace(sp.id);
    rail.appendChild(b);
  });
  const sep = document.createElement('div');
  sep.className = 'rail-sep';
  rail.appendChild(sep);
  const add = document.createElement('button');
  add.className = 'server-icon add';
  add.textContent = '+';
  add.title = 'Criar servidor';
  add.onclick = () => openModal('spaceModal');
  rail.appendChild(add);
  const inv = document.createElement('button');
  inv.className = 'server-icon add';
  inv.textContent = '🔗';
  inv.title = 'Entrar por convite';
  inv.onclick = () => openModal('inviteModal');
  rail.appendChild(inv);
}

function selectSpace(id) {
  currentSpaceId = id;
  renderRail();
  renderChannels();
  const sp = getSpace(id);
  const first = sp.channels.find((c) => c.type === 'text') || sp.channels[0];
  if (first) selectChannel(id, first.id);
  else showEmpty();
}

// ========================================================================
//  LISTA DE CANAIS
// ========================================================================
function renderChannels() {
  const sp = getSpace(currentSpaceId);
  if (!sp) return;
  spaceNameEl.textContent = sp.name;
  channelList.innerHTML = '';

  const texts = sp.channels.filter((c) => c.type === 'text');
  const voices = sp.channels.filter((c) => c.type === 'voice');

  channelList.appendChild(catLabel('Canais de texto', () => openChannelModal('text')));
  texts.forEach((c) => channelList.appendChild(channelEl(sp.id, c)));

  channelList.appendChild(catLabel('Canais de voz', () => openChannelModal('voice')));
  voices.forEach((c) => {
    channelList.appendChild(channelEl(sp.id, c));
    if (voice && voice.key === key(sp.id, c.id)) {
      const wrap = document.createElement('div');
      wrap.className = 'voice-members';
      ['local', ...Object.keys(voiceParticipants).filter((p) => p !== 'local')].forEach(
        (pid) => wrap.appendChild(voiceMemberEl(pid))
      );
      channelList.appendChild(wrap);
    }
  });
}

function catLabel(text, onAdd) {
  const d = document.createElement('div');
  d.className = 'cat-label';
  const span = document.createElement('span');
  span.textContent = text;
  const b = document.createElement('button');
  b.textContent = '+';
  b.title = 'Criar canal';
  b.onclick = onAdd;
  d.append(span, b);
  return d;
}

function channelEl(spaceId, ch) {
  const k = key(spaceId, ch.id);
  const b = document.createElement('button');
  b.className =
    'channel ' +
    (ch.type === 'voice' ? 'voice ' : '') +
    (viewKey === k ? 'active ' : '') +
    (voice && voice.key === k ? 'connected' : '');
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = ch.type === 'voice' ? '🔊' : '#';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = ch.name;
  b.append(ico, nm);
  b.onclick = () => selectChannel(spaceId, ch.id);
  return b;
}

function voiceMemberEl(pid) {
  const d = document.createElement('div');
  d.className = 'voice-member';
  d.id = 'vm-' + pid;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = initialOf(nickOf(pid));
  av.style.background = `hsl(${hueOf(pid)} 55% 45%)`;
  const nm = document.createElement('span');
  nm.textContent = pid === 'local' ? `${nickOf(pid)} (você)` : nickOf(pid);
  d.append(av, nm);
  return d;
}

// ========================================================================
//  SELEÇÃO DE CANAL (texto vs voz)
// ========================================================================
function selectChannel(spaceId, chId) {
  const ch = getChannel(spaceId, chId);
  if (!ch) return;
  viewKey = key(spaceId, chId);
  if (ch.type === 'text') showTextView(spaceId, ch);
  else showVoiceView(spaceId, ch);
  renderChannels();
}

function showEmpty() {
  emptyView.classList.remove('hidden');
  textView.classList.add('hidden');
  voiceView.classList.add('hidden');
}

// ---- Canal de texto -----------------------------------------------------
function showTextView(spaceId, ch) {
  textView.classList.remove('hidden');
  voiceView.classList.add('hidden');
  emptyView.classList.add('hidden');
  $('textTitle').textContent = ch.name;
  joinText(key(spaceId, ch.id));
}

function joinText(k) {
  if (textRoomKey === k) {
    renderMessages(k);
    return;
  }
  if (textRoom) textRoom.leave();
  textRoomKey = k;
  textRoom = joinRoom(
    { appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } },
    'text:' + k
  );
  const [send, get] = textRoom.makeAction('chat');
  sendChat = send;
  get((msg, pid) => pushMsg(k, textPeerNicks[pid] || pid.slice(0, 6), msg));
  const [sendNick, getNick] = textRoom.makeAction('nick');
  textRoom.onPeerJoin(() => sendNick(myNick()));
  getNick((name, pid) => (textPeerNicks[pid] = name));
  renderMessages(k);
}

function pushMsg(k, from, text, sys) {
  (messagesByChannel[k] || (messagesByChannel[k] = [])).push({ from, text, sys });
  if (k === textRoomKey && !textView.classList.contains('hidden')) appendMsgEl({ from, text, sys });
}

function renderMessages(k) {
  messages.innerHTML = '';
  (messagesByChannel[k] || []).forEach(appendMsgEl);
}

function appendMsgEl({ from, text, sys }) {
  const li = document.createElement('li');
  if (sys) li.className = 'sys';
  li.innerHTML = sys
    ? escapeHtml(text)
    : `<b>${escapeHtml(from)}:</b> ${escapeHtml(text)}`;
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || !sendChat) return;
  sendChat(text);
  pushMsg(textRoomKey, `${myNick()} (você)`, text);
  input.value = '';
};

// ---- Canal de voz -------------------------------------------------------
function showVoiceView(spaceId, ch) {
  voiceView.classList.remove('hidden');
  textView.classList.add('hidden');
  emptyView.classList.add('hidden');
  $('voiceTitle').textContent = ch.name;
  const k = key(spaceId, ch.id);
  const here = voice && voice.key === k;
  $('btnJoinVoice').classList.toggle('hidden', here);
  $('vcButtons').classList.toggle('hidden', !here);
  if (here) {
    renderStage();
  } else {
    stageVideo.style.display = 'none';
    stageAvatar.style.display = 'none';
    placeholder.style.display = '';
    placeholder.textContent = voice
      ? `Você está em "${voice.name}". Entre aqui para trocar de canal de voz.`
      : 'Entre na voz para conversar';
  }
}

$('btnJoinVoice').onclick = () => {
  const { spaceId, channelId } = parseKey(viewKey);
  joinVoice(spaceId, getChannel(spaceId, channelId));
};
$('btnDisconnect').onclick = () => leaveVoice();
$('btnLeaveVoice').onclick = () => leaveVoice();

async function joinVoice(spaceId, ch) {
  if (voice) leaveVoice();
  const k = key(spaceId, ch.id);
  voice = { key: k, spaceId, channelId: ch.id, name: ch.name, room: null };
  console.log('[voz] selfId=', selfId, 'entrando no canal de voz:', k);
  voice.room = joinRoom(
    { appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } },
    'voice:' + k
  );
  setupVoiceRoom(voice.room);
  ensureParticipant('local');
  focusedKey = 'local';
  await applyMic(); // voz por padrão ao entrar
  updateVoiceStatus();
  showVoiceView(spaceId, ch);
  renderChannels();
}

function leaveVoice() {
  if (!voice) return;
  stopCam();
  stopScreen();
  stopMicHard();
  Object.keys(tiles).forEach(removeTile);
  Object.keys(vadCleanups).forEach(detachVAD);
  voiceParticipants = {};
  audioSinks.innerHTML = '';
  focusedKey = null;
  try {
    voice.room.leave();
  } catch (e) {}
  const wasKey = voice.key;
  voice = null;
  updateVoiceStatus();
  renderChannels();
  if (viewKey === wasKey) {
    const { spaceId, channelId } = parseKey(wasKey);
    showVoiceView(spaceId, getChannel(spaceId, channelId));
  }
}

function setupVoiceRoom(room) {
  const [sendNick, getNick] = room.makeAction('nick');
  room.__sendNick = sendNick;
  getNick((name, pid) => {
    voiceParticipants[pid] = name;
    refreshTileLabels(pid);
    renderChannels();
  });

  room.onPeerJoin((pid) => {
    console.log('[voz] peer entrou:', pid);
    voiceParticipants[pid] = voiceParticipants[pid] || pid.slice(0, 6);
    sendNick(myNick());
    if (micStream) room.addStream(micStream, pid, { kind: 'mic' });
    if (camStream) room.addStream(camStream, pid, { kind: 'camera' });
    if (screenStream) room.addStream(screenStream, pid, { kind: 'screen' });
    renderChannels();
  });

  room.onPeerLeave((pid) => {
    detachVAD(pid);
    removeTile(pid);
    removeTile(pid + ':screen');
    const a = $('audio-' + pid);
    if (a) a.remove();
    delete voiceParticipants[pid];
    renderChannels();
    renderStage();
  });

  room.onPeerStream((stream, pid, meta) => {
    const kind = (meta && meta.kind) || 'camera';
    if (kind === 'mic') {
      let a = document.getElementById('audio-' + pid);
      if (!a) {
        a = document.createElement('audio');
        a.id = 'audio-' + pid;
        a.autoplay = true;
        audioSinks.appendChild(a);
      }
      a.srcObject = stream;
      configureAudioEl(a);
      ensureParticipant(pid);
      attachVAD(pid, stream);
    } else if (kind === 'screen') {
      addScreenTile(pid, stream);
      onVideoEnded(stream, () => removeTile(pid + ':screen'));
    } else {
      setParticipantCamera(pid, stream);
      onVideoEnded(stream, () => setParticipantCamera(pid, null));
    }
  });
}

function updateVoiceStatus() {
  const vs = $('voiceStatus');
  if (voice) {
    vs.classList.remove('hidden');
    $('vsChannel').textContent = voice.name;
  } else {
    vs.classList.add('hidden');
  }
}

// ========================================================================
//  MÍDIA (mic / câmera / tela)  — opera sobre voice.room
// ========================================================================
async function applyMic() {
  const first = !micStream;
  let ns;
  try {
    ns = await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (err) {
    pushSys('microfone: ' + err.message);
    updateMicButton();
    return;
  }
  if (voice && micStream) voice.room.removeStream(micStream);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = ns;
  if (first) micEnabled = true;
  micStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  if (voice) voice.room.addStream(micStream, null, { kind: 'mic' });
  ensureParticipant('local');
  attachVAD('local', micStream);
  updateMicButton();
  populateDevices();
}

function stopMicHard() {
  if (!micStream) return;
  if (voice) voice.room.removeStream(micStream);
  micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  micEnabled = false;
  detachVAD('local');
}

$('btnMic').onclick = () => {
  if (!micStream) return applyMic();
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

$('btnCam').onclick = async () => {
  if (camStream) return stopCam();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (voice) voice.room.addStream(camStream, null, { kind: 'camera' });
    setParticipantCamera('local', camStream);
    camStream.getVideoTracks()[0].addEventListener('ended', stopCam);
    $('btnCam').classList.add('active');
  } catch (err) {
    pushSys('câmera: ' + err.message);
  }
};
function stopCam() {
  if (!camStream) return;
  if (voice) voice.room.removeStream(camStream);
  camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  setParticipantCamera('local', null);
  $('btnCam').classList.remove('active');
}

$('btnScreen').onclick = async () => {
  if (screenStream) return stopScreen();
  const sources = await window.desktop.getSources();
  showSourcePicker(sources, async (id) => {
    await window.desktop.setChosenSource(id);
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (voice) voice.room.addStream(screenStream, null, { kind: 'screen' });
      addScreenTile('local', screenStream);
      screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);
      $('btnScreen').classList.add('active');
    } catch (err) {
      pushSys('tela: ' + err.message);
    }
  });
};
function stopScreen() {
  if (!screenStream) return;
  if (voice) voice.room.removeStream(screenStream);
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  removeTile('local:screen');
  $('btnScreen').classList.remove('active');
}

// ========================================================================
//  TILES / PALCO
// ========================================================================
function ensureParticipant(pid) {
  let t = tiles[pid];
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile participant';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.display = 'none';
    if (pid === 'local') video.classList.add('mirror');
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const lab = document.createElement('span');
    lab.className = 'label';
    const pip = document.createElement('button');
    pip.className = 'pipbtn';
    pip.textContent = '⧉';
    pip.style.display = 'none';
    pip.onclick = (e) => {
      e.stopPropagation();
      togglePip(video);
    };
    el.append(video, avatar, lab, pip);
    el.onclick = () => setFocus(pid);
    t = tiles[pid] = { el, video, avatar, lab, pip, kind: 'participant', peerId: pid, stream: null };
    filmstrip.appendChild(el);
  }
  refreshTileLabels(pid);
  return t;
}

function setParticipantCamera(pid, stream) {
  const t = ensureParticipant(pid);
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

function addScreenTile(pid, stream) {
  const k = pid + ':screen';
  let t = tiles[k];
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile screen';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.autoPictureInPicture = true;
    const lab = document.createElement('span');
    lab.className = 'label';
    const pip = document.createElement('button');
    pip.className = 'pipbtn';
    pip.textContent = '⧉';
    pip.onclick = (e) => {
      e.stopPropagation();
      togglePip(video);
    };
    el.append(video, lab, pip);
    el.onclick = () => setFocus(k);
    t = tiles[k] = { el, video, lab, pip, kind: 'screen', peerId: pid, stream };
    filmstrip.appendChild(el);
  }
  t.stream = stream;
  t.video.srcObject = stream;
  t.lab.textContent = `${nickOf(pid)} · tela`;
  setFocus(k);
}

function refreshTileLabels(pid) {
  const t = tiles[pid];
  if (t && t.kind === 'participant') {
    const name = nickOf(pid);
    t.lab.textContent = pid === 'local' ? `${name} (você)` : name;
    t.avatar.textContent = initialOf(name);
    t.avatar.style.background = `hsl(${hueOf(pid)} 55% 45%)`;
  }
  const st = tiles[pid + ':screen'];
  if (st) st.lab.textContent = `${nickOf(pid)} · tela`;
}

function setFocus(k) {
  focusedKey = k;
  renderStage();
}

function removeTile(k) {
  const t = tiles[k];
  if (!t) return;
  t.el.remove();
  delete tiles[k];
  if (focusedKey === k) focusedKey = null;
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
    placeholder.textContent = 'Entre na voz para conversar';
    stage.classList.remove('speaking');
    return;
  }
  placeholder.style.display = 'none';
  stage.classList.toggle('speaking', t.el.classList.contains('speaking'));
  if (t.stream) {
    stageVideo.srcObject = t.stream;
    stageVideo.classList.toggle('mirror', t.kind === 'participant' && t.peerId === 'local');
    stageVideo.style.display = 'block';
    stageAvatar.style.display = 'none';
  } else {
    stageAvatar.textContent = initialOf(nickOf(t.peerId));
    stageAvatar.style.background = `hsl(${hueOf(t.peerId)} 55% 45%)`;
    stageVideo.style.display = 'none';
    stageAvatar.style.display = 'flex';
  }
}

function onVideoEnded(stream, cb) {
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', cb));
}

// ========================================================================
//  VAD (detecção de voz)
// ========================================================================
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.addEventListener('pointerdown', () => audioCtx && audioCtx.resume());

function attachVAD(pid, stream) {
  if (!stream.getAudioTracks().length) return;
  detachVAD(pid);
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
    levels[pid] = avg;
    const now = performance.now();
    if (avg > SPEAKING_THRESHOLD) lastSpoke = now;
    setSpeaking(pid, now - lastSpoke < SPEAKING_HANGOVER);
    raf = requestAnimationFrame(tick);
  };
  tick();
  vadCleanups[pid] = () => {
    running = false;
    cancelAnimationFrame(raf);
    try {
      src.disconnect();
    } catch (e) {}
    setSpeaking(pid, false);
  };
}
function detachVAD(pid) {
  if (vadCleanups[pid]) {
    vadCleanups[pid]();
    delete vadCleanups[pid];
  }
}
function setSpeaking(pid, on) {
  const t = tiles[pid];
  if (t) t.el.classList.toggle('speaking', on);
  const m = $('vm-' + pid);
  if (m) m.classList.toggle('speaking', on);
  if (focusedKey === pid) stage.classList.toggle('speaking', on);
}

// ========================================================================
//  PICTURE-IN-PICTURE
// ========================================================================
async function togglePip(video) {
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else {
      if (!video.srcObject || video.readyState === 0) return;
      await video.requestPictureInPicture();
    }
  } catch (err) {
    pushSys('PiP: ' + err.message);
  }
}
$('btnPip').onclick = () => {
  const screenKey = Object.keys(tiles).find((k) => tiles[k].kind === 'screen');
  if (screenKey) setFocus(screenKey);
  togglePip(stageVideo);
};

// ========================================================================
//  CONFIGURAÇÕES / DISPOSITIVOS
// ========================================================================
const settings = Object.assign(
  { micId: '', outputId: '', volume: 1, noise: true, echo: true, agc: true, turnUrl: '', turnUser: '', turnPass: '' },
  JSON.parse(localStorage.getItem('p2pSettings') || '{}')
);
function saveSettings() {
  localStorage.setItem('p2pSettings', JSON.stringify(settings));
}
function buildIceServers() {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  if (settings.turnUrl.trim()) {
    const urls = settings.turnUrl.split(',').map((s) => s.trim()).filter(Boolean);
    const entry = { urls };
    if (settings.turnUser) entry.username = settings.turnUser;
    if (settings.turnPass) entry.credential = settings.turnPass;
    list.push(entry);
  }
  return list;
}
function micConstraints() {
  const audio = { echoCancellation: settings.echo, noiseSuppression: settings.noise, autoGainControl: settings.agc };
  if (settings.micId) audio.deviceId = { exact: settings.micId };
  return { audio };
}
function configureAudioEl(el) {
  el.volume = settings.volume;
  if (settings.outputId && el.setSinkId) el.setSinkId(settings.outputId).catch(() => {});
}
function applyOutputToAll() {
  audioSinks.querySelectorAll('audio').forEach(configureAudioEl);
}
async function populateDevices() {
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    return;
  }
  fillSelect($('selMic'), devices.filter((d) => d.kind === 'audioinput'), settings.micId, 'Microfone');
  fillSelect($('selSpeaker'), devices.filter((d) => d.kind === 'audiooutput'), settings.outputId, 'Saída');
}
function fillSelect(sel, devices, selected, kind) {
  sel.innerHTML = '';
  if (!devices.length) {
    sel.innerHTML = '<option value="">(nenhum dispositivo)</option>';
    return;
  }
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `${kind} ${i + 1}`;
    if (d.deviceId === selected) o.selected = true;
    sel.append(o);
  });
}
function syncSettingsUI() {
  $('rngVolume').value = Math.round(settings.volume * 100);
  $('chkNoise').checked = settings.noise;
  $('chkEcho').checked = settings.echo;
  $('chkAgc').checked = settings.agc;
  $('inpTurnUrl').value = settings.turnUrl;
  $('inpTurnUser').value = settings.turnUser;
  $('inpTurnPass').value = settings.turnPass;
}
let meterRaf = null;
$('btnSettings').onclick = () => {
  syncSettingsUI();
  populateDevices();
  openModal('settingsModal');
  const fill = $('meterFill');
  const loop = () => {
    fill.style.width = Math.min(100, ((levels['local'] || 0) / 60) * 100).toFixed(0) + '%';
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
};
$('settingsClose').onclick = () => {
  closeModal('settingsModal');
  if (meterRaf) cancelAnimationFrame(meterRaf);
};
$('selMic').onchange = (e) => {
  settings.micId = e.target.value;
  saveSettings();
  if (voice) applyMic();
};
$('selSpeaker').onchange = (e) => {
  settings.outputId = e.target.value;
  saveSettings();
  applyOutputToAll();
};
$('rngVolume').oninput = (e) => {
  settings.volume = e.target.value / 100;
  saveSettings();
  applyOutputToAll();
};
$('chkNoise').onchange = (e) => {
  settings.noise = e.target.checked;
  saveSettings();
  if (voice) applyMic();
};
$('chkEcho').onchange = (e) => {
  settings.echo = e.target.checked;
  saveSettings();
  if (voice) applyMic();
};
$('chkAgc').onchange = (e) => {
  settings.agc = e.target.checked;
  saveSettings();
  if (voice) applyMic();
};
$('inpTurnUrl').oninput = (e) => {
  settings.turnUrl = e.target.value;
  saveSettings();
};
$('inpTurnUser').oninput = (e) => {
  settings.turnUser = e.target.value;
  saveSettings();
};
$('inpTurnPass').oninput = (e) => {
  settings.turnPass = e.target.value;
  saveSettings();
};
$('btnReconnect').onclick = () => {
  if (voice) {
    const { spaceId, channelId } = parseKey(voice.key);
    joinVoice(spaceId, getChannel(spaceId, channelId));
  }
};
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', populateDevices);

// ========================================================================
//  SELETOR DE FONTE DE TELA
// ========================================================================
function showSourcePicker(sources, onPick) {
  const list = $('sourceList');
  list.innerHTML = '';
  sources.forEach((s) => {
    const isScreen = s.id.startsWith('screen:');
    const item = document.createElement('div');
    item.className = 'source-item';
    item.innerHTML = `
      <div class="thumb"><img src="${s.thumbnail}" /></div>
      <div class="meta">
        <span class="badge">${isScreen ? '🖥️ Tela' : '🪟 Janela'}</span>
        <span class="name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
      </div>`;
    item.onclick = () => {
      closeModal('sourceModal');
      onPick(s.id);
    };
    list.append(item);
  });
  openModal('sourceModal');
}
$('sourceCancel').onclick = () => closeModal('sourceModal');

// ========================================================================
//  MODAIS: criar servidor / convite / criar canal / menu do servidor
// ========================================================================
function openModal(id) {
  $(id).classList.remove('hidden');
}
function closeModal(id) {
  $(id).classList.add('hidden');
}

$('spaceCancel').onclick = () => closeModal('spaceModal');
$('spaceCreate').onclick = () => {
  const name = $('spaceNameInput').value.trim();
  if (!name) return;
  const sp = store.createSpace(name, $('spaceIconInput').value.trim());
  spaces.push(sp);
  store.saveSpaces(spaces);
  $('spaceNameInput').value = '';
  $('spaceIconInput').value = '';
  closeModal('spaceModal');
  selectSpace(sp.id);
};

$('inviteCancel').onclick = () => closeModal('inviteModal');
$('inviteJoin').onclick = () => {
  const sp = store.decodeInvite($('inviteInput').value);
  if (!sp) {
    $('inviteInput').classList.add('invalid');
    return;
  }
  if (!getSpace(sp.id)) {
    spaces.push(sp);
    store.saveSpaces(spaces);
  }
  $('inviteInput').value = '';
  $('inviteInput').classList.remove('invalid');
  closeModal('inviteModal');
  selectSpace(sp.id);
};
$('inviteInput').oninput = () => $('inviteInput').classList.remove('invalid');

let pendingChannelType = 'text';
function openChannelModal(type) {
  pendingChannelType = type || 'text';
  document.querySelector(`input[name="chType"][value="${pendingChannelType}"]`).checked = true;
  openModal('channelModal');
  $('channelNameInput').focus();
}
$('channelCancel').onclick = () => closeModal('channelModal');
$('channelCreate').onclick = () => {
  const name = $('channelNameInput').value.trim();
  if (!name) return;
  const type = document.querySelector('input[name="chType"]:checked').value;
  const sp = getSpace(currentSpaceId);
  sp.channels.push(store.createChannel(name, type));
  store.saveSpaces(spaces);
  $('channelNameInput').value = '';
  closeModal('channelModal');
  renderChannels();
};

$('btnSpaceMenu').onclick = () => {
  $('spaceMenuTitle').textContent = getSpace(currentSpaceId).name;
  $('inviteCopied').style.display = 'none';
  openModal('spaceMenuModal');
};
$('spaceMenuClose').onclick = () => closeModal('spaceMenuModal');
$('menuAddChannel').onclick = () => {
  closeModal('spaceMenuModal');
  openChannelModal('text');
};
$('menuCopyInvite').onclick = async () => {
  const code = store.encodeInvite(getSpace(currentSpaceId));
  try {
    await navigator.clipboard.writeText(code);
    $('inviteCopied').style.display = '';
  } catch (e) {
    pushSys('convite: ' + code);
  }
};
$('menuLeaveSpace').onclick = () => {
  if (spaces.length <= 1) return; // não sair do último
  spaces = spaces.filter((s) => s.id !== currentSpaceId);
  store.saveSpaces(spaces);
  closeModal('spaceMenuModal');
  selectSpace(spaces[0].id);
};

// ========================================================================
//  UTIL
// ========================================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function renderMeBar() {
  $('meNick').textContent = myNick();
  const av = $('meAvatar');
  av.textContent = initialOf(myNick());
  av.style.background = `hsl(${hueOf('local')} 55% 45%)`;
}

// ========================================================================
//  BOOT + GATE DE APELIDO
// ========================================================================
function boot() {
  renderMeBar();
  renderRail();
  renderChannels();
  const sp = getSpace(currentSpaceId);
  const first = sp.channels.find((c) => c.type === 'text') || sp.channels[0];
  if (first) selectChannel(currentSpaceId, first.id);
  else showEmpty();
}

function showNickGate() {
  const input = $('nickInput');
  openModal('nickModal');
  input.focus();
  const submit = () => {
    const v = input.value.trim();
    if (!v) {
      input.classList.add('invalid');
      return;
    }
    store.setNick(v);
    closeModal('nickModal');
    boot();
  };
  $('nickConfirm').onclick = submit;
  input.oninput = () => input.classList.remove('invalid');
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };
}

// Parâmetros de teste (via env no main.js): nick + canal de voz a entrar.
const params = new URLSearchParams(location.search);
if (params.get('nick')) store.setNick(params.get('nick'));

if (store.getNick()) {
  boot();
  const jv = params.get('joinVoice');
  if (jv) {
    const { spaceId, channelId } = parseKey(jv);
    const ch = getChannel(spaceId, channelId);
    if (ch) {
      selectSpace(spaceId);
      joinVoice(spaceId, ch);
    }
  }
} else {
  showNickGate();
}
