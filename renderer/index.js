import './polyfill.js'; // deve vir ANTES do trystero
import { joinRoom, selfId } from 'trystero/torrent';
import * as store from './store.js';
import * as identity from './identity.js';

const APP_ID = 'dishorse-p2p';
const SPEAKING_THRESHOLD = 12;
const SPEAKING_HANGOVER = 300;

const $ = (id) => document.getElementById(id);

// ---- Estado -------------------------------------------------------------
let spaces = store.loadSpaces();
let currentSpaceId = spaces[0]?.id || null;
let viewKey = null; // canal em exibição ("spaceId:channelId")
const discoveryRooms = {}; // id -> sala 'srv:<id>' (serve o manifesto por descoberta)
let mode = 'server'; // 'server' | 'dm'
let currentDM = null; // { pub, nick }
let dmList = [];
try {
  dmList = JSON.parse(localStorage.getItem('p2pDMs') || '[]');
} catch (e) {}
let inboxRoom = null; // caixa de entrada (recebe convites de DM)
const dmRooms = {}; // pub -> sala da DM (mantida em 2º plano)
const dmSend = {}; // pub -> enviar mensagem
const dmDel = {}; // pub -> excluir mensagem
const dmIdentsByKey = {}; // dmKey -> { peerId -> ident }
const dmUnread = {}; // pub -> nº de não lidas

// presença em canais de voz (ver quem está na call sem entrar)
const presenceRooms = {}; // channelKey -> sala 'vpres:<key>'
const presenceMembers = {}; // channelKey -> { peerId -> {pub,nick,verified} }

// texto
let textRoom = null;
let textRoomKey = null;
let sendChat = null;
let textAnnounceMan = null; // broadcast do manifesto na sala de texto ativa
const messagesByChannel = {}; // key -> [{from,text,sys,verified}]

// chat lateral do canal de voz (sala própria por canal de voz)
let voiceChatRoom = null;
let voiceChatSend = null;
let voiceChatSendDel = null;
const voiceChatIdents = {};
const voiceChatMsgs = [];
const voiceChatDeleted = new Set();

// anexos pendentes (aguardando "Enviar") e exclusão
let pendingChatImage = null;
let pendingVoiceImage = null;
let textSendDel = null;
const deletedIdsByChannel = {}; // k -> Set de ids apagados (oculta chegadas tardias)
const msgId = () => Math.random().toString(36).slice(2, 10);

function showChatPreview(containerId, img, onClear) {
  const p = $(containerId);
  p.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'preview-chip';
  const image = document.createElement('img');
  image.src = img;
  const x = document.createElement('button');
  x.textContent = '✕';
  x.title = 'Remover anexo';
  x.onclick = onClear;
  wrap.append(image, x);
  p.append(wrap);
  p.classList.remove('hidden');
}
function addDeleteBtn(el, onDel) {
  const b = document.createElement('button');
  b.className = 'msg-del';
  b.textContent = '🗑';
  b.title = 'Excluir';
  b.onclick = onDel;
  el.appendChild(b);
}

// voz (persiste enquanto navego em canais de texto)
let voice = null; // { key, spaceId, channelId, name, room }
let voiceParticipants = {}; // peerId -> { pub, nick, verified }
const textIdents = {}; // peerId -> { pub, nick, verified } (por sala de texto ativa)

// mídia local
let micStream = null;
let micEnabled = true; // intenção de mic (aplicada ao entrar na voz)
let deafened = false; // surdo: não toca o áudio dos peers
let camStream = null;
let screenStream = null;
let screenWatchers = new Set(); // peers assistindo MINHA tela
let currentlyWatching = null; // peerId de quem estou assistindo (tela)

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
// identidade dos participantes de voz
const nickOf = (pid) =>
  pid === 'local' ? myNick() : voiceParticipants[pid]?.nick || pid.slice(0, 6);
const pubOf = (pid) => (pid === 'local' ? identity.pub() : voiceParticipants[pid]?.pub || '');
const verifiedOf = (pid) => (pid === 'local' ? true : !!voiceParticipants[pid]?.verified);
const colorKey = (pid) => pubOf(pid) || pid; // cor estável por chave pública
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
  const home = document.createElement('button');
  home.className = 'server-icon home' + (mode === 'dm' ? ' active' : '');
  home.textContent = '📨';
  home.title = 'Mensagens diretas';
  home.onclick = selectDMMode;
  rail.appendChild(home);
  const sepTop = document.createElement('div');
  sepTop.className = 'rail-sep';
  rail.appendChild(sepTop);

  spaces.forEach((sp) => {
    const b = document.createElement('button');
    b.className = 'server-icon' + (mode === 'server' && sp.id === currentSpaceId ? ' active' : '');
    applyServerIcon(b, sp);
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
  add.onclick = openSpaceCreate;
  rail.appendChild(add);
  const inv = document.createElement('button');
  inv.className = 'server-icon add';
  inv.textContent = '🔗';
  inv.title = 'Entrar por convite';
  inv.onclick = () => openModal('inviteModal');
  rail.appendChild(inv);
}

function selectSpace(id) {
  mode = 'server';
  currentSpaceId = id;
  renderRail();
  renderChannels();
  const sp = getSpace(id);
  const first = sp.channels.find((c) => c.type === 'text') || sp.channels[0];
  if (first) selectChannel(id, first.id);
  else showEmpty();
}

// ---- Mensagens diretas (DMs) --------------------------------------------
function saveDMs() {
  localStorage.setItem('p2pDMs', JSON.stringify(dmList));
}
function addDM(pub, nick) {
  const ex = dmList.find((d) => d.pub === pub);
  if (ex) ex.nick = nick;
  else dmList.push({ pub, nick });
  saveDMs();
}
async function dmKey(peerPub) {
  const pair = [identity.pub(), peerPub].sort().join(':');
  return 'dm:' + (await identity.hashId(pair));
}
function selectDMMode() {
  mode = 'dm';
  renderRail();
  renderChannels();
  if (currentDM) selectDM(currentDM.pub, currentDM.nick);
  else showEmpty();
}
// Junta na sala da DM em 2º plano (recebe mensagens mesmo sem estar aberta).
async function joinDMRoom(pub, nick) {
  if (dmRooms[pub]) return;
  const k = await dmKey(pub);
  const room = joinRoom({ appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } }, 'text:' + k);
  dmRooms[pub] = room;
  const idents = (dmIdentsByKey[k] = dmIdentsByKey[k] || {});
  const announce = attachHandshake(room, idents);
  const [send, get] = room.makeAction('chat');
  dmSend[pub] = async (text, img) => {
    const id = msgId();
    const sig = await identity.sign(signContent(text, img));
    send({ text, img, sig, id });
    return id;
  };
  get(async (payload, pid) => {
    if (deletedIdsByChannel[k]?.has(payload.id)) return;
    const idn = idents[pid];
    const nm = idn?.nick || pid.slice(0, 6);
    const verified = idn
      ? await identity.verify(idn.pub, payload.sig, signContent(payload.text, payload.img))
      : false;
    pushMsg(k, nm, payload.text, false, verified, payload.img, { id: payload.id, authorPub: idn?.pub });
    if (!(mode === 'dm' && currentDM && currentDM.pub === pub)) {
      dmUnread[pub] = (dmUnread[pub] || 0) + 1;
      renderRail();
      if (mode === 'dm') renderChannels();
    }
  });
  const [sendDel, getDel] = room.makeAction('del');
  dmDel[pub] = async (id) => {
    const sig = await identity.sign('del:' + id);
    sendDel({ id, sig });
  };
  getDel(async (payload) => {
    const m = (messagesByChannel[k] || []).find((x) => x.id === payload.id);
    if (!m) return (deletedIdsByChannel[k] || (deletedIdsByChannel[k] = new Set())).add(payload.id);
    const ok = m.authorPub && (await identity.verify(m.authorPub, payload.sig, 'del:' + payload.id));
    if (ok) {
      m.deleted = true;
      if (k === textRoomKey) renderMessages(k);
    }
  });
  room.onPeerJoin((pid) => {
    announce(pid);
    setTimeout(() => {
      if (!idents[pid]) announce(pid);
    }, 2500);
  });
}

// Caixa de entrada: quem quer te mandar DM avisa aqui; você passa a receber.
async function startInbox() {
  const myHash = await identity.hashId(identity.pub());
  inboxRoom = joinRoom({ appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } }, 'inbox:' + myHash);
  const [, getDM] = inboxRoom.makeAction('dm');
  getDM(async (msg) => {
    if (!msg || !msg.pub || msg.pub === identity.pub()) return;
    addDM(msg.pub, msg.nick || msg.pub.slice(0, 6));
    await joinDMRoom(msg.pub, msg.nick);
    if (mode === 'dm') renderChannels();
    renderRail();
  });
}

// Avisa o inbox do outro que quero conversar.
async function sendDMInvite(pub, nick) {
  const theirHash = await identity.hashId(pub);
  const room = joinRoom({ appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } }, 'inbox:' + theirHash);
  const [sendDM] = room.makeAction('dm');
  const fire = () => sendDM({ pub: identity.pub(), nick: myNick() });
  room.onPeerJoin(fire);
  setTimeout(() => {
    try {
      room.leave();
    } catch (e) {}
  }, 15000);
}

// Inicia uma DM (a partir do perfil): registra, entra na sala e convida o outro.
async function startDM(pub, nick) {
  addDM(pub, nick);
  await joinDMRoom(pub, nick);
  sendDMInvite(pub, nick);
  selectDM(pub, nick);
}

async function selectDM(pub, nick) {
  mode = 'dm';
  addDM(pub, nick);
  currentDM = { pub, nick };
  dmUnread[pub] = 0;
  await joinDMRoom(pub, nick);
  const k = await dmKey(pub);
  viewKey = k;
  textRoomKey = k;
  sendChat = dmSend[pub];
  textSendDel = dmDel[pub];
  textView.classList.remove('hidden');
  voiceView.classList.add('hidden');
  emptyView.classList.add('hidden');
  $('welcomeView').classList.add('hidden');
  $('textTitle').textContent = '@' + nick;
  renderMessages(k);
  renderRail();
  renderChannels();
}
function renderDMList() {
  spaceNameEl.textContent = 'Mensagens Diretas';
  $('btnSpaceMenu').style.display = 'none';
  channelList.innerHTML = '';
  if (!dmList.length) {
    const p = document.createElement('div');
    p.className = 'cat-label';
    p.innerHTML = '<span>Nenhuma conversa ainda</span>';
    channelList.append(p);
    return;
  }
  dmList.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'channel' + (currentDM && currentDM.pub === d.pub ? ' active' : '');
    const av = document.createElement('div');
    av.className = 'avatar dm-av';
    av.textContent = initialOf(d.nick);
    av.style.background = `hsl(${hueOf(d.pub)} 55% 45%)`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = d.nick;
    row.append(av, nm);
    if (dmUnread[d.pub]) {
      const badge = document.createElement('span');
      badge.className = 'dm-badge';
      badge.textContent = dmUnread[d.pub];
      row.append(badge);
    }
    row.onclick = () => selectDM(d.pub, d.nick);
    channelList.append(row);
  });
}

// ========================================================================
//  PRESENÇA EM CANAIS DE VOZ
// ========================================================================
// Quem está na call se anuncia (announcePresence); quem só visualiza observa.
function joinPresence(k) {
  if (presenceRooms[k]) return;
  const room = joinRoom({ appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } }, 'vpres:' + k);
  presenceRooms[k] = room;
  presenceMembers[k] = presenceMembers[k] || {};
  const [sendIdent, getIdent] = room.makeAction('ident');
  const [sendGone, getGone] = room.makeAction('gone');
  room.__presSend = sendIdent;
  room.__presGone = sendGone;
  getIdent(async (msg, pid) => {
    const verified = await identity.verify(msg.pub, msg.sig, msg.pub);
    presenceMembers[k][pid] = { pub: msg.pub, nick: msg.nick, verified };
    if (mode === 'server') renderChannels();
  });
  getGone((msg) => {
    if (!msg || !msg.pub) return;
    for (const pid in presenceMembers[k]) {
      if (presenceMembers[k][pid].pub === msg.pub) delete presenceMembers[k][pid];
    }
    if (mode === 'server') renderChannels();
  });
  room.onPeerJoin((pid) => {
    if (voice && voice.key === k) announcePresence(k, pid);
  });
  room.onPeerLeave((pid) => {
    delete presenceMembers[k][pid];
    if (mode === 'server') renderChannels();
  });
}
async function announcePresence(k, target) {
  const room = presenceRooms[k];
  if (!room) return;
  const sig = await identity.sign(identity.pub());
  room.__presSend({ pub: identity.pub(), nick: myNick(), sig }, target);
}
function gonePresence(k) {
  const room = presenceRooms[k];
  if (room && room.__presGone) room.__presGone({ pub: identity.pub() });
}
function presenceMemberEl(pid, m) {
  const d = document.createElement('div');
  d.className = 'voice-member';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = initialOf(m.nick);
  av.style.background = `hsl(${hueOf(m.pub || pid)} 55% 45%)`;
  const nm = document.createElement('span');
  nm.className = 'vm-name';
  nm.textContent = m.nick;
  d.append(av, nm);
  const right = document.createElement('span');
  right.className = 'vm-right';
  if (m.verified) {
    const b = document.createElement('span');
    b.className = 'verified';
    b.textContent = '✓';
    right.append(b);
  }
  const sp = getSpace(currentSpaceId);
  if (sp && store.isOwner(sp) && m.pub && m.pub !== identity.pub()) {
    const ban = document.createElement('button');
    ban.className = 'vm-ban';
    ban.textContent = '✕';
    ban.title = 'Banir do servidor';
    ban.onclick = (e) => {
      e.stopPropagation();
      banUser(m.pub);
    };
    right.append(ban);
  }
  d.append(right);
  d.onclick = () => openProfileByPub(m.pub, m.nick, m.verified);
  return d;
}
function openProfileByPub(pub, nick, verified) {
  const el = $('profileAvatar');
  el.style.backgroundImage = 'none';
  el.style.backgroundColor = `hsl(${hueOf(pub || nick)} 55% 45%)`;
  el.textContent = initialOf(nick);
  $('profileNick').textContent = nick + (verified ? ' ✓' : '');
  $('profileFp').textContent = pub ? '#' + identity.fingerprint(pub) : '';
  $('profileBioView').textContent = 'Sem bio.';
  profileViewPub = pub;
  profileViewNick = nick;
  $('profileMessage').style.display = pub && pub !== identity.pub() ? '' : 'none';
  $('profileEdit').style.display = 'none';
  $('profileView').style.display = '';
  openModal('profileModal');
}

// ========================================================================
//  LISTA DE CANAIS
// ========================================================================
function renderChannels() {
  if (mode === 'dm') return renderDMList();
  const sp = getSpace(currentSpaceId);
  if (!sp) {
    spaceNameEl.textContent = 'Nenhum servidor';
    $('btnSpaceMenu').style.display = 'none';
    channelList.innerHTML = '';
    return;
  }
  $('btnSpaceMenu').style.display = '';
  spaceNameEl.textContent = sp.name;
  channelList.innerHTML = '';

  const texts = sp.channels.filter((c) => c.type === 'text');
  const voices = sp.channels.filter((c) => c.type === 'voice');

  const editable = store.canEdit(sp);
  channelList.appendChild(catLabel('Canais de texto', editable ? () => openChannelModal('text') : null));
  texts.forEach((c) => channelList.appendChild(channelEl(sp.id, c)));

  channelList.appendChild(catLabel('Canais de voz', editable ? () => openChannelModal('voice') : null));
  voices.forEach((c) => {
    channelList.appendChild(channelEl(sp.id, c));
    const ck = key(sp.id, c.id);
    joinPresence(ck); // observa quem está na call
    if (voice && voice.key === ck) {
      // conectado: usa participantes de mídia (com estado/fala) + eu
      const others = Object.keys(voiceParticipants).filter(
        (p) => p !== 'local' && !isBannedPub(voiceParticipants[p]?.pub)
      );
      const wrap = document.createElement('div');
      wrap.className = 'voice-members';
      ['local', ...others].forEach((pid) => wrap.appendChild(voiceMemberEl(pid)));
      channelList.appendChild(wrap);
    } else {
      // não conectado: mostra presença (quem está na call)
      const members = presenceMembers[ck] || {};
      const pids = Object.keys(members).filter((pid) => !isBannedPub(members[pid].pub));
      if (pids.length) {
        const wrap = document.createElement('div');
        wrap.className = 'voice-members';
        pids.forEach((pid) => wrap.appendChild(presenceMemberEl(pid, members[pid])));
        channelList.appendChild(wrap);
      }
    }
  });
}

function catLabel(text, onAdd) {
  const d = document.createElement('div');
  d.className = 'cat-label';
  const span = document.createElement('span');
  span.textContent = text;
  d.append(span);
  if (onAdd) {
    const b = document.createElement('button');
    b.textContent = '+';
    b.title = 'Criar canal';
    b.onclick = onAdd;
    d.append(b);
  }
  return d;
}

function channelEl(spaceId, ch) {
  const k = key(spaceId, ch.id);
  const row = document.createElement('div');
  row.className =
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
  row.append(ico, nm);
  row.onclick = () => selectChannel(spaceId, ch.id);
  // ações do dono (renomear/remover)
  if (store.canEdit(getSpace(spaceId))) {
    const actions = document.createElement('span');
    actions.className = 'ch-actions';
    const ren = document.createElement('button');
    ren.textContent = '✎';
    ren.title = 'Renomear canal';
    ren.onclick = (e) => {
      e.stopPropagation();
      renameChannel(spaceId, ch);
    };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Remover canal';
    del.onclick = (e) => {
      e.stopPropagation();
      removeChannel(spaceId, ch);
    };
    actions.append(ren, del);
    row.append(actions);
  }
  return row;
}

function voiceMemberEl(pid) {
  const d = document.createElement('div');
  d.className = 'voice-member';
  d.id = 'vm-' + pid;
  const av = document.createElement('div');
  av.className = 'avatar';
  applyAvatarEl(av, pid);
  const nm = document.createElement('span');
  nm.className = 'vm-name';
  nm.textContent = pid === 'local' ? `${nickOf(pid)} (você)` : nickOf(pid);
  d.append(av, nm);
  d.onclick = () => (pid === 'local' ? openMyProfile() : openPeerProfile(pid));

  const right = document.createElement('span');
  right.className = 'vm-right';
  if (verifiedOf(pid)) right.append(verifiedBadge(pid));
  const st = stateOf(pid);
  if (st.muted) right.append(statusIcon('🔇', 'mudo'));
  if (st.deaf) right.append(statusIcon('🙉', 'surdo (saída mutada)'));
  if (st.cam) right.append(statusIcon('📷', 'câmera ligada'));
  if (st.screen) right.append(statusIcon('🖥️', 'transmitindo tela'));
  // botão de banir: só o dono do servidor, e não em si mesmo
  const sp = getSpace(voice?.spaceId);
  if (pid !== 'local' && sp && store.isOwner(sp) && pubOf(pid)) {
    const ban = document.createElement('button');
    ban.className = 'vm-ban';
    ban.textContent = '✕';
    ban.title = 'Banir do servidor';
    ban.onclick = (e) => {
      e.stopPropagation();
      banUser(pubOf(pid));
    };
    right.append(ban);
  }
  d.append(right);
  return d;
}
function statusIcon(ch, title) {
  const s = document.createElement('span');
  s.className = 'st-ico';
  s.textContent = ch;
  s.title = title;
  return s;
}

// pequeno selo de identidade verificada, com o fingerprint no title
function verifiedBadge(pid) {
  const b = document.createElement('span');
  b.className = 'verified';
  b.textContent = '✓';
  b.title = 'Identidade verificada · #' + identity.fingerprint(pubOf(pid));
  return b;
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
  $('welcomeView').classList.add('hidden');
}

// ---- Canal de texto -----------------------------------------------------
function showTextView(spaceId, ch) {
  textView.classList.remove('hidden');
  voiceView.classList.add('hidden');
  emptyView.classList.add('hidden');
  $('welcomeView').classList.add('hidden');
  $('textTitle').textContent = ch.name;
  joinText(key(spaceId, ch.id));
}

function joinText(k) {
  if (textRoomKey === k) {
    renderMessages(k);
    return;
  }
  if (textRoom) textRoom.leave();
  for (const p in textIdents) delete textIdents[p];
  textRoomKey = k;
  textRoom = joinRoom(
    { appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } },
    'text:' + k
  );

  // handshake de identidade
  const [sendIdent, getIdent] = textRoom.makeAction('ident');
  const announced = new Set();
  const announce = async (target) => {
    if (target) announced.add(target);
    sendIdent(await identPayload(), target);
  };
  textAnnounceIdent = announce;
  getIdent(async (msg, pid) => {
    const verified = await identity.verify(msg.pub, msg.sig, msg.pub);
    textIdents[pid] = { pub: msg.pub, nick: msg.nick, verified, avatar: msg.avatar, bio: msg.bio };
    if (!announced.has(pid)) announce(pid); // responde se meu anúncio se perdeu
  });
  textAnnounceMan = manifestSync(textRoom, parseKey(k).spaceId);
  textRoom.onPeerJoin((pid) => {
    announce(pid);
    textAnnounceMan(pid);
    setTimeout(() => {
      if (!textIdents[pid]) announce(pid); // retry defensivo
    }, 2500);
  });

  // chat assinado
  const [send, get] = textRoom.makeAction('chat');
  sendChat = async (text, img) => {
    const id = msgId();
    const sig = await identity.sign(signContent(text, img));
    send({ text, img, sig, id });
    return id;
  };
  get(async (payload, pid) => {
    if (deletedIdsByChannel[k]?.has(payload.id)) return; // já apagada
    const id = textIdents[pid];
    const nick = id?.nick || pid.slice(0, 6);
    const verified = id
      ? await identity.verify(id.pub, payload.sig, signContent(payload.text, payload.img))
      : false;
    pushMsg(k, nick, payload.text, false, verified, payload.img, { id: payload.id, authorPub: id?.pub });
  });

  const [sendDel, getDel] = textRoom.makeAction('del');
  textSendDel = async (id) => {
    const sig = await identity.sign('del:' + id);
    sendDel({ id, sig });
  };
  getDel(async (payload) => {
    const m = (messagesByChannel[k] || []).find((x) => x.id === payload.id);
    if (!m) {
      (deletedIdsByChannel[k] || (deletedIdsByChannel[k] = new Set())).add(payload.id);
      return;
    }
    const ok = m.authorPub && (await identity.verify(m.authorPub, payload.sig, 'del:' + payload.id));
    if (ok) {
      m.deleted = true;
      if (k === textRoomKey) renderMessages(k);
    }
  });

  renderMessages(k);
}

function pushMsg(k, from, text, sys, verified, img, meta) {
  const m = { from, text, sys, verified, img, id: meta?.id, authorPub: meta?.authorPub, mine: meta?.mine, deleted: false };
  (messagesByChannel[k] || (messagesByChannel[k] = [])).push(m);
  if (k === textRoomKey && !textView.classList.contains('hidden')) appendMsgEl(m);
}

function renderMessages(k) {
  messages.innerHTML = '';
  (messagesByChannel[k] || []).filter((m) => !m.deleted).forEach(appendMsgEl);
}

function deleteTextMsg(id) {
  const m = (messagesByChannel[textRoomKey] || []).find((x) => x.id === id);
  if (m) m.deleted = true;
  renderMessages(textRoomKey);
  if (textSendDel) textSendDel(id);
}

// monta o corpo de uma mensagem (texto/imagem/selo) em um container
function fillMsgEl(el, { from, text, sys, verified, img }) {
  if (sys) {
    el.className = (el.className + ' sys').trim();
    el.textContent = text;
    return;
  }
  const badge = verified
    ? '<span class="verified" title="assinatura verificada">✓</span> '
    : '<span class="unverified" title="mensagem sem assinatura verificada">⚠</span> ';
  let body = `${badge}<b>${escapeHtml(from)}:</b>`;
  if (text) body += ` ${escapeHtml(text)}`;
  el.innerHTML = body;
  if (img) {
    const image = document.createElement('img');
    image.className = 'chat-img';
    image.src = img;
    image.onclick = () => openImageViewer(img);
    el.appendChild(image);
  }
}

function appendMsgEl(m) {
  const li = document.createElement('li');
  fillMsgEl(li, m);
  if (m.mine && !m.sys) addDeleteBtn(li, () => deleteTextMsg(m.id));
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

function openImageViewer(src) {
  $('imageViewerImg').src = src;
  openModal('imageModal');
}
$('imageModal').onclick = () => closeModal('imageModal');

$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if ((!text && !pendingChatImage) || !sendChat) return;
  const img = pendingChatImage;
  const id = await sendChat(text, img);
  pushMsg(textRoomKey, `${myNick()} (você)`, text, false, true, img, { id, authorPub: identity.pub(), mine: true });
  input.value = '';
  clearChatPreview();
};
$('chatAttach').onclick = () => $('chatImageInput').click();
$('chatImageInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingChatImage = await imageFileToChat(file);
    showChatPreview('chatPreview', pendingChatImage, clearChatPreview);
  } catch (err) {
    pushSys('imagem: ' + err.message);
  }
  e.target.value = '';
};
function clearChatPreview() {
  pendingChatImage = null;
  const p = $('chatPreview');
  p.classList.add('hidden');
  p.innerHTML = '';
}

// ---- Canal de voz -------------------------------------------------------
function showVoiceView(spaceId, ch) {
  voiceView.classList.remove('hidden');
  textView.classList.add('hidden');
  emptyView.classList.add('hidden');
  $('welcomeView').classList.add('hidden');
  $('voiceTitle').textContent = ch.name;
  const k = key(spaceId, ch.id);
  const here = voice && voice.key === k;
  $('btnJoinVoice').classList.toggle('hidden', here);
  $('vcButtons').classList.toggle('hidden', !here);
  $('stagePip').style.display = here ? '' : 'none';
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
  setupVoiceRoom(voice.room, spaceId);
  ensureParticipant('local');
  focusedKey = 'local';
  joinVoiceChat(k); // chat lateral da sala
  joinPresence(k); // presença (para os outros verem que entrei)
  announcePresence(k); // anuncia a quem já está observando o canal
  await applyMic(); // voz por padrão ao entrar
  updateVoiceStatus();
  showVoiceView(spaceId, ch);
  renderChannels();
}

function leaveVoice() {
  if (!voice) return;
  gonePresence(voice.key); // avisa que saí da call
  stopPipLoop();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  leaveVoiceChat();
  stopCam();
  stopScreen();
  stopMicHard();
  Object.keys(tiles).forEach(removeTile);
  Object.keys(vadCleanups).forEach(detachVAD);
  voiceParticipants = {};
  screenWatchers = new Set();
  currentlyWatching = null;
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

function setupVoiceRoom(room, spaceId) {
  const [sendIdent, getIdent] = room.makeAction('ident');
  const announced = new Set(); // peers a quem já anunciei minha identidade
  const announce = async (target) => {
    if (target) announced.add(target);
    sendIdent(await identPayload(), target);
  };
  if (voice) voice.announceIdent = announce;
  getIdent(async (msg, pid) => {
    const verified = await identity.verify(msg.pub, msg.sig, msg.pub);
    const prev = voiceParticipants[pid] || {};
    voiceParticipants[pid] = {
      pub: msg.pub, nick: msg.nick, verified, state: prev.state, avatar: msg.avatar, bio: msg.bio,
    };
    if (isBannedPub(msg.pub)) return removeParticipant(pid); // cooperativo
    if (!announced.has(pid)) announce(pid); // meu anúncio pode ter se perdido: respondo
    refreshTileLabels(pid);
    renderChannels();
  });

  // estado de mídia (mudo / câmera / tela) para ícones na lista
  const [sendState, getState] = room.makeAction('state');
  if (voice) voice.sendState = sendState;
  getState((st, pid) => {
    const p = voiceParticipants[pid] || (voiceParticipants[pid] = { nick: pid.slice(0, 6), verified: false });
    p.state = st;
    renderChannels();
  });

  // quem está assistindo MINHA tela (o receptor sinaliza ao focar/desfocar)
  const [sendWatch, getWatch] = room.makeAction('watch');
  if (voice) voice.sendWatch = sendWatch;
  getWatch((msg, pid) => {
    if (msg && msg.on) screenWatchers.add(pid);
    else screenWatchers.delete(pid);
    renderWatchers();
    applyScreenBitrate(); // ajusta o envio conforme quem assiste
  });

  const announceMan = manifestSync(room, spaceId);
  if (voice) voice.announceMan = announceMan;

  room.onPeerJoin((pid) => {
    console.log('[voz] peer entrou:', pid);
    voiceParticipants[pid] = voiceParticipants[pid] || { nick: pid.slice(0, 6), verified: false };
    announce(pid);
    announceMan(pid);
    sendState(localState(), pid);
    if (micStream) room.addStream(micStream, pid, { kind: 'mic' });
    if (camStream) room.addStream(camStream, pid, { kind: 'camera' });
    if (screenStream) room.addStream(screenStream, pid, { kind: 'screen' });
    if (camStream || screenStream) setTimeout(applyEncodingParams, 800);
    // retry defensivo: se em 2.5s ainda não recebi a identidade dele, reanuncio
    setTimeout(() => {
      if (voiceParticipants[pid] && !voiceParticipants[pid].pub) announce(pid);
    }, 2500);
    renderChannels();
  });

  room.onPeerLeave((pid) => {
    detachVAD(pid);
    removeTile(pid);
    removeTile(pid + ':screen');
    const a = $('audio-' + pid);
    if (a) a.remove();
    delete voiceParticipants[pid];
    if (screenWatchers.delete(pid)) renderWatchers();
    renderChannels();
    renderStage();
  });

  room.onPeerStream((stream, pid, meta) => {
    if (voiceParticipants[pid] && isBannedPub(voiceParticipants[pid].pub)) return;
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

// ---- Chat lateral do canal de voz ---------------------------------------
// handshake de identidade reutilizável (responde ao receber + registra)
function attachHandshake(room, identsMap) {
  const [sendIdent, getIdent] = room.makeAction('ident');
  const announced = new Set();
  const announce = async (target) => {
    if (target) announced.add(target);
    sendIdent(await identPayload(), target);
  };
  getIdent(async (msg, pid) => {
    const verified = await identity.verify(msg.pub, msg.sig, msg.pub);
    identsMap[pid] = { pub: msg.pub, nick: msg.nick, verified, avatar: msg.avatar, bio: msg.bio };
    if (!announced.has(pid)) announce(pid);
  });
  return announce;
}

function joinVoiceChat(k) {
  leaveVoiceChat();
  voiceChatRoom = joinRoom(
    { appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } },
    'vchat:' + k
  );
  const announce = attachHandshake(voiceChatRoom, voiceChatIdents);
  vchatAnnounceIdent = announce;
  const [send, get] = voiceChatRoom.makeAction('chat');
  voiceChatSend = async (text, img) => {
    const id = msgId();
    const sig = await identity.sign(signContent(text, img));
    send({ text, img, sig, id });
    return id;
  };
  get(async (payload, pid) => {
    if (voiceChatDeleted.has(payload.id)) return;
    const id = voiceChatIdents[pid];
    const nick = id?.nick || pid.slice(0, 6);
    const verified = id
      ? await identity.verify(id.pub, payload.sig, signContent(payload.text, payload.img))
      : false;
    voiceChatMsgs.push({ id: payload.id, from: nick, text: payload.text, verified, img: payload.img, authorPub: id?.pub });
    renderVoiceChat();
  });
  const [sendDel, getDel] = voiceChatRoom.makeAction('del');
  voiceChatSendDel = async (id) => {
    const sig = await identity.sign('del:' + id);
    sendDel({ id, sig });
  };
  getDel(async (payload) => {
    const m = voiceChatMsgs.find((x) => x.id === payload.id);
    if (!m) return voiceChatDeleted.add(payload.id);
    const ok = m.authorPub && (await identity.verify(m.authorPub, payload.sig, 'del:' + payload.id));
    if (ok) {
      m.deleted = true;
      renderVoiceChat();
    }
  });
  voiceChatRoom.onPeerJoin((pid) => {
    announce(pid);
    setTimeout(() => {
      if (!voiceChatIdents[pid]) announce(pid);
    }, 2500);
  });
  renderVoiceChat();
}

function leaveVoiceChat() {
  if (voiceChatRoom) {
    try {
      voiceChatRoom.leave();
    } catch (e) {}
    voiceChatRoom = null;
  }
  voiceChatSend = null;
  voiceChatSendDel = null;
  voiceChatMsgs.length = 0;
  voiceChatDeleted.clear();
  pendingVoiceImage = null;
  for (const p in voiceChatIdents) delete voiceChatIdents[p];
  renderVoiceChat();
}

function renderVoiceChat() {
  const box = $('voiceChatMessages');
  if (!box) return;
  box.innerHTML = '';
  voiceChatMsgs
    .filter((m) => !m.deleted)
    .forEach((m) => {
      const div = document.createElement('div');
      div.className = 'vc-msg';
      fillMsgEl(div, m);
      if (m.mine) addDeleteBtn(div, () => deleteVoiceMsg(m.id));
      box.append(div);
    });
  box.scrollTop = box.scrollHeight;
}
function deleteVoiceMsg(id) {
  const m = voiceChatMsgs.find((x) => x.id === id);
  if (m) m.deleted = true;
  renderVoiceChat();
  if (voiceChatSendDel) voiceChatSendDel(id);
}

$('voiceChatForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('voiceChatInput');
  const text = input.value.trim();
  if ((!text && !pendingVoiceImage) || !voiceChatSend) return;
  const img = pendingVoiceImage;
  const id = await voiceChatSend(text, img);
  voiceChatMsgs.push({ id, from: `${myNick()} (você)`, text, verified: true, img, authorPub: identity.pub(), mine: true });
  renderVoiceChat();
  input.value = '';
  clearVoicePreview();
};
$('voiceChatAttach').onclick = () => $('voiceChatImageInput').click();
$('voiceChatImageInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingVoiceImage = await imageFileToChat(file);
    showChatPreview('voiceChatPreview', pendingVoiceImage, clearVoicePreview);
  } catch (err) {
    pushSys('imagem: ' + err.message);
  }
  e.target.value = '';
};
function clearVoicePreview() {
  pendingVoiceImage = null;
  const p = $('voiceChatPreview');
  p.classList.add('hidden');
  p.innerHTML = '';
}
$('voiceChatToggle').onclick = () => $('voiceChat').classList.toggle('collapsed');

// ---- estado de mídia (para ícones e broadcast) --------------------------
function localState() {
  return { muted: !micStream || !micEnabled, deaf: deafened, cam: !!camStream, screen: !!screenStream };
}
function stateOf(pid) {
  return pid === 'local'
    ? localState()
    : voiceParticipants[pid]?.state || { muted: true, deaf: false, cam: false, screen: false };
}
function broadcastState() {
  if (voice && voice.sendState) voice.sendState(localState());
}
// chamar em toda mudança de mídia: atualiza ícones locais + avisa os peers
function updateVoiceUI() {
  renderChannels();
  broadcastState();
}

// ---- banimento (cooperativo, só o dono) ---------------------------------
function isBannedPub(pub) {
  const sp = getSpace(voice?.spaceId);
  return !!(pub && sp && (sp.banned || []).includes(pub));
}
function removeParticipant(pid) {
  detachVAD(pid);
  removeTile(pid);
  removeTile(pid + ':screen');
  const a = $('audio-' + pid);
  if (a) a.remove();
  delete voiceParticipants[pid];
  renderChannels();
  renderStage();
}
function enforceBans() {
  if (!voice) return;
  Object.keys(voiceParticipants).forEach((pid) => {
    if (pid !== 'local' && isBannedPub(voiceParticipants[pid].pub)) removeParticipant(pid);
  });
}
async function banUser(pub) {
  const sp = getSpace(currentSpaceId);
  if (!sp || !store.isOwner(sp) || !pub) return;
  if (!sp.banned) sp.banned = [];
  if (!sp.banned.includes(pub)) sp.banned.push(pub);
  await store.bumpAndSign(sp);
  store.saveSpaces(spaces);
  broadcastManifest(sp.id); // banido recebe e sai sozinho (cooperativo)
  enforceBans();
  renderChannels();
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
  micStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled)); // respeita intenção
  if (voice) voice.room.addStream(micStream, null, { kind: 'mic' });
  ensureParticipant('local');
  attachVAD('local', micStream);
  updateMicButton();
  updateVoiceUI();
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
  setMicEnabled(!micEnabled);
};
$('meMic').onclick = () => setMicEnabled(!micEnabled);
$('meDeafen').onclick = () => setDeafen(!deafened);

function setMicEnabled(v) {
  micEnabled = v;
  settings.micMuted = !v;
  saveSettings();
  if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = v));
  updateMicButton();
  updateMeControls();
  if (voice) updateVoiceUI();
}
function setDeafen(v) {
  deafened = v;
  settings.deafened = v;
  saveSettings();
  applyDeafen();
  updateMeControls();
  if (voice) updateVoiceUI();
}
function applyDeafen() {
  audioSinks.querySelectorAll('audio').forEach((a) => (a.muted = deafened));
}
function updateMeControls() {
  const m = $('meMic');
  m.textContent = micEnabled ? '🎤' : '🔇';
  m.classList.toggle('off', !micEnabled);
  const d = $('meDeafen');
  d.textContent = deafened ? '🙉' : '🎧';
  d.classList.toggle('off', deafened);
}
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
    camStream = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
    if (voice) voice.room.addStream(camStream, null, { kind: 'camera' });
    setParticipantCamera('local', camStream);
    camStream.getVideoTracks()[0].addEventListener('ended', stopCam);
    $('btnCam').classList.add('active');
    updateVoiceUI();
    setTimeout(applyEncodingParams, 800); // após a negociação
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
  updateVoiceUI();
}

$('btnScreen').onclick = async () => {
  if (screenStream) return stopScreen();
  const sources = await window.desktop.getSources();
  showSourcePicker(sources, async (id) => {
    await window.desktop.setChosenSource(id);
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: screenConstraints(), audio: false });
      if (voice) voice.room.addStream(screenStream, null, { kind: 'screen' });
      addScreenTile('local', screenStream);
      screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);
      $('btnScreen').classList.add('active');
      updateVoiceUI();
      setTimeout(applyEncodingParams, 800);
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
  screenWatchers = new Set();
  removeTile('local:screen');
  $('btnScreen').classList.remove('active');
  updateVoiceUI();
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
    el.append(video, avatar, lab);
    el.onclick = () => setFocus(pid);
    t = tiles[pid] = { el, video, avatar, lab, kind: 'participant', peerId: pid, stream: null };
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
  } else {
    t.video.srcObject = null;
    t.video.style.display = 'none';
    t.avatar.style.display = 'flex';
  }
  renderStage();
}

// Telas aparecem como PREVIEW borrado no filmstrip (sem decodificar). Só a tela
// em foco toca ao vivo no palco. A própria tela abre automaticamente; as dos
// outros ficam como preview até o usuário clicar em "assistir".
function addScreenTile(pid, stream) {
  const k = pid + ':screen';
  const isLocal = pid === 'local';
  let t = tiles[k];
  if (!t) {
    const el = document.createElement('div');
    el.className = 'tile screen preview';
    const poster = document.createElement('div');
    poster.className = 'poster';
    const play = document.createElement('div');
    play.className = 'play-overlay';
    play.innerHTML = '<span>▶ assistir</span>';
    const lab = document.createElement('span');
    lab.className = 'label';
    el.append(poster, play, lab);
    el.onclick = () => setFocus(k);
    t = tiles[k] = { el, posterEl: poster, lab, kind: 'screen', peerId: pid, stream };
    filmstrip.appendChild(el);
  }
  t.stream = stream;
  t.lab.textContent = `${nickOf(pid)} · tela`;
  if (isLocal) setFocus(k); // só a própria tela abre sozinha
  else renderStage(); // as dos outros ficam em preview
}

// Congela um frame do palco como poster (borrado) do tile de tela que sai de foco.
function capturePoster(tile) {
  try {
    if (!stageVideo.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = Math.min(320, stageVideo.videoWidth);
    c.height = Math.round((c.width * stageVideo.videoHeight) / stageVideo.videoWidth);
    c.getContext('2d').drawImage(stageVideo, 0, 0, c.width, c.height);
    tile.posterEl.style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.5)})`;
  } catch (e) {}
}

function refreshTileLabels(pid) {
  const t = tiles[pid];
  if (t && t.kind === 'participant') {
    const name = nickOf(pid);
    const check = verifiedOf(pid) ? ' ✓' : '';
    t.lab.textContent = (pid === 'local' ? `${name} (você)` : name) + check;
    applyAvatarEl(t.avatar, pid);
  }
  const st = tiles[pid + ':screen'];
  if (st) st.lab.textContent = `${nickOf(pid)} · tela`;
}

function setFocus(k) {
  // ao sair de uma tela, congela seu último frame como poster do preview
  if (focusedKey && focusedKey !== k && tiles[focusedKey]?.kind === 'screen') {
    capturePoster(tiles[focusedKey]);
  }
  focusedKey = k;
  renderStage();
  updateWatching();
}

// sinaliza ao dono da tela que estou (ou parei de) assistir
function updateWatching() {
  if (!voice || !voice.sendWatch) return;
  const t = focusedKey && tiles[focusedKey];
  const watchPid = t && t.kind === 'screen' && t.peerId !== 'local' ? t.peerId : null;
  if (watchPid === currentlyWatching) return;
  if (currentlyWatching) voice.sendWatch({ on: false }, currentlyWatching);
  if (watchPid) voice.sendWatch({ on: true }, watchPid);
  currentlyWatching = watchPid;
}

// mostra no meu tile de tela quantos/quem está assistindo
function renderWatchers() {
  const t = tiles['local:screen'];
  if (!t) return;
  const n = screenWatchers.size;
  const names = [...screenWatchers].map((pid) => nickOf(pid)).join(', ');
  t.lab.textContent = `você · tela${n ? ` · 👁 ${n}` : ''}`;
  t.el.title = n ? `Assistindo: ${names}` : '';
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
    // NÃO auto-focar telas dos outros (viram preview); prioriza participantes
    focusedKey =
      (tiles['local'] ? 'local' : null) ||
      keys.find((k) => tiles[k].kind === 'participant') ||
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
    applyAvatarEl(stageAvatar, t.peerId);
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
  if (on) activeSpeaker = pid; // acompanha quem fala (para o PiP de avatar)
}

// ========================================================================
//  PICTURE-IN-PICTURE
// ========================================================================
// PiP global do palco: um canvas espelha o que está em foco — a transmissão
// aberta (tela/câmera) ou, quando não há vídeo, o card com a inicial do falante
// atual (estilo Discord). Assim o PiP acompanha foco e quem está falando.
let pipCanvas = null;
let pipCtx = null;
let pipVideo = null;
let pipRaf = null;
let activeSpeaker = 'local';

function ensurePipEls() {
  if (pipCanvas) return;
  pipCanvas = document.createElement('canvas');
  pipCanvas.width = 640;
  pipCanvas.height = 360;
  pipCtx = pipCanvas.getContext('2d');
  pipVideo = document.createElement('video');
  pipVideo.muted = true;
  pipVideo.autoplay = true;
  pipVideo.playsInline = true;
  pipVideo.style.display = 'none';
  document.body.appendChild(pipVideo);
  pipVideo.addEventListener('leavepictureinpicture', stopPipLoop);
}

function stopPipLoop() {
  if (pipRaf) cancelAnimationFrame(pipRaf);
  pipRaf = null;
}

function isSpeaking(pid) {
  return (
    tiles[pid]?.el.classList.contains('speaking') ||
    $('vm-' + pid)?.classList.contains('speaking') ||
    false
  );
}

function drawPipAvatar(pid) {
  const w = pipCanvas.width;
  const h = pipCanvas.height;
  pipCtx.fillStyle = '#14171d';
  pipCtx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.28;
  if (isSpeaking(pid)) {
    pipCtx.beginPath();
    pipCtx.arc(cx, cy, r + 9, 0, Math.PI * 2);
    pipCtx.strokeStyle = '#22c55e';
    pipCtx.lineWidth = 7;
    pipCtx.stroke();
  }
  pipCtx.beginPath();
  pipCtx.arc(cx, cy, r, 0, Math.PI * 2);
  pipCtx.fillStyle = `hsl(${hueOf(colorKey(pid))} 55% 45%)`;
  pipCtx.fill();
  pipCtx.fillStyle = '#fff';
  pipCtx.font = `bold ${Math.round(r)}px system-ui, sans-serif`;
  pipCtx.textAlign = 'center';
  pipCtx.textBaseline = 'middle';
  pipCtx.fillText(initialOf(nickOf(pid)), cx, cy + 3);
}

function drawPipFrame() {
  const w = pipCanvas.width;
  const h = pipCanvas.height;
  const t = focusedKey && tiles[focusedKey];
  if (t && t.stream && stageVideo.videoWidth) {
    // desenha o vídeo em foco mantendo o aspecto (contain)
    pipCtx.fillStyle = '#000';
    pipCtx.fillRect(0, 0, w, h);
    const vw = stageVideo.videoWidth;
    const vh = stageVideo.videoHeight;
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    const mirror = t.kind === 'participant' && t.peerId === 'local';
    if (mirror) {
      pipCtx.save();
      pipCtx.translate(w, 0);
      pipCtx.scale(-1, 1);
      pipCtx.drawImage(stageVideo, w - dx - dw, dy, dw, dh);
      pipCtx.restore();
    } else {
      pipCtx.drawImage(stageVideo, dx, dy, dw, dh);
    }
  } else {
    // sem vídeo: card do falante atual (ou do foco)
    const pid = voiceParticipants[activeSpeaker] || activeSpeaker === 'local' ? activeSpeaker : t?.peerId || 'local';
    drawPipAvatar(pid);
  }
  pipRaf = requestAnimationFrame(drawPipFrame);
}

async function toggleStagePip() {
  ensurePipEls();
  try {
    if (document.pictureInPictureElement === pipVideo) {
      await document.exitPictureInPicture();
      return;
    }
    if (!pipRaf) drawPipFrame();
    if (!pipVideo.srcObject) pipVideo.srcObject = pipCanvas.captureStream(15);
    await pipVideo.play();
    await pipVideo.requestPictureInPicture();
  } catch (err) {
    stopPipLoop();
    pushSys('PiP: ' + err.message);
  }
}
$('stagePip').onclick = toggleStagePip;

// ========================================================================
//  CONFIGURAÇÕES / DISPOSITIVOS
// ========================================================================
const settings = Object.assign(
  {
    micId: '', outputId: '', volume: 1, noise: true, echo: true, agc: true,
    maxHeight: 720, maxFps: 30, // qualidade de transmissão (0 = sem limite)
    micMuted: false, deafened: false, // config de entrada na call
    turnUrl: '', turnUser: '', turnPass: '',
  },
  JSON.parse(localStorage.getItem('p2pSettings') || '{}')
);

// ---- Qualidade de transmissão ------------------------------------------
function camConstraints() {
  const v = {};
  if (settings.maxHeight) {
    v.height = { ideal: settings.maxHeight };
    v.width = { ideal: Math.round((settings.maxHeight * 16) / 9) };
  }
  if (settings.maxFps) v.frameRate = { ideal: settings.maxFps, max: settings.maxFps };
  return Object.keys(v).length ? v : true;
}
function screenConstraints() {
  const v = {};
  if (settings.maxHeight) v.height = { max: settings.maxHeight };
  if (settings.maxFps) v.frameRate = { ideal: settings.maxFps, max: settings.maxFps };
  return Object.keys(v).length ? v : true;
}
function bitrateFor(h) {
  if (!h) return 0; // sem limite
  if (h <= 360) return 500e3;
  if (h <= 480) return 900e3;
  if (h <= 720) return 1_800_000;
  if (h <= 1080) return 3_500_000;
  return 0;
}
async function setSenderMax(sender, maxBitrate, maxFramerate) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = maxBitrate || undefined;
    if (maxFramerate) p.encodings[0].maxFramerate = maxFramerate;
    await sender.setParameters(p);
  } catch (e) {}
}
// Bitrate/fps da CÂMERA (a tela é tratada por applyScreenBitrate).
function applyEncodingParams() {
  if (!voice || !voice.room.getPeers) return;
  const max = bitrateFor(settings.maxHeight);
  const screenTrack = screenStream?.getVideoTracks()[0];
  Object.values(voice.room.getPeers()).forEach((pc) => {
    if (!pc.getSenders) return;
    pc.getSenders().forEach((sender) => {
      if (!sender.track || sender.track.kind !== 'video') return;
      if (sender.track === screenTrack) return; // tela: applyScreenBitrate
      setSenderMax(sender, max, settings.maxFps);
    });
  });
  applyScreenBitrate();
}
// Envia a tela em qualidade cheia só para quem está assistindo; para os demais,
// reduz a um fio (economia real de upload quando ninguém está olhando).
function applyScreenBitrate() {
  if (!voice || !screenStream || !voice.room.getPeers) return;
  const track = screenStream.getVideoTracks()[0];
  if (!track) return;
  const normal = bitrateFor(settings.maxHeight) || 3_000_000;
  Object.entries(voice.room.getPeers()).forEach(([pid, pc]) => {
    if (!pc.getSenders) return;
    const sender = pc.getSenders().find((s) => s.track === track);
    if (!sender) return;
    const watching = screenWatchers.has(pid);
    setSenderMax(sender, watching ? normal : 30_000, watching ? settings.maxFps : 2);
  });
}
// Aplica a nova qualidade às transmissões já ativas, sem reabrir.
function applyLiveVideoQuality() {
  const fps = settings.maxFps ? { frameRate: { max: settings.maxFps } } : {};
  const res = settings.maxHeight ? { height: { ideal: settings.maxHeight } } : {};
  if (camStream) camStream.getVideoTracks()[0]?.applyConstraints({ ...res, ...fps }).catch(() => {});
  if (screenStream) screenStream.getVideoTracks()[0]?.applyConstraints({ ...fps }).catch(() => {});
  applyEncodingParams();
}
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
  el.muted = deafened;
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
  $('selRes').value = String(settings.maxHeight);
  $('selFps').value = String(settings.maxFps);
  $('inpTurnUrl').value = settings.turnUrl;
  $('inpTurnUser').value = settings.turnUser;
  $('inpTurnPass').value = settings.turnPass;
}
let meterRaf = null;
$('chkBackground').onchange = (e) => window.appPrefs?.setBackground(e.target.checked);
$('chkAutostart').onchange = (e) => window.appPrefs?.setAutostart(e.target.checked);
$('btnSettings').onclick = () => {
  syncSettingsUI();
  populateDevices();
  if (window.appPrefs)
    window.appPrefs.get().then((p) => {
      $('chkBackground').checked = p.background;
      $('chkAutostart').checked = p.autostart;
    });
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
$('selRes').onchange = (e) => {
  settings.maxHeight = parseInt(e.target.value, 10) || 0;
  saveSettings();
  applyLiveVideoQuality();
};
$('selFps').onchange = (e) => {
  settings.maxFps = parseInt(e.target.value, 10) || 0;
  saveSettings();
  applyLiveVideoQuality();
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

// prompt de texto reutilizável (Electron não suporta window.prompt)
function promptText(title, initial) {
  return new Promise((resolve) => {
    $('promptTitle').textContent = title;
    const input = $('promptInput');
    input.value = initial || '';
    openModal('promptModal');
    input.focus();
    input.select();
    const done = (val) => {
      closeModal('promptModal');
      $('promptOk').onclick = null;
      $('promptCancel').onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    $('promptOk').onclick = () => done(input.value.trim() || null);
    $('promptCancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    };
  });
}

// ---- Gerenciamento pelo dono (renomear/remover/desbanir) ----------------
async function commitManifest(sp) {
  if (store.isOwned(sp)) await store.bumpAndSign(sp);
  store.saveSpaces(spaces);
  broadcastManifest(sp.id);
}
async function renameChannel(spaceId, ch) {
  const name = await promptText('Renomear canal', ch.name);
  if (!name) return;
  const sp = getSpace(spaceId);
  const c = sp.channels.find((x) => x.id === ch.id);
  if (!c) return;
  c.name = name;
  await commitManifest(sp);
  renderChannels();
  const k = key(spaceId, ch.id);
  if (voice && voice.key === k) {
    voice.name = name;
    updateVoiceStatus();
  }
  if (viewKey === k) {
    if (c.type === 'text') $('textTitle').textContent = name;
    else $('voiceTitle').textContent = name;
  }
}
async function removeChannel(spaceId, ch) {
  if (!confirm(`Remover o canal "${ch.name}"?`)) return;
  const sp = getSpace(spaceId);
  sp.channels = sp.channels.filter((c) => c.id !== ch.id);
  await commitManifest(sp);
  const k = key(spaceId, ch.id);
  if (voice && voice.key === k) leaveVoice();
  renderChannels();
  if (viewKey === k) {
    const first = sp.channels.find((c) => c.type === 'text') || sp.channels[0];
    if (first) selectChannel(spaceId, first.id);
    else showEmpty();
  }
}
function openBanned() {
  const sp = getSpace(currentSpaceId);
  const list = $('bannedList');
  list.innerHTML = '';
  const banned = sp.banned || [];
  if (!banned.length) {
    list.innerHTML = '<p class="hint">Ninguém banido.</p>';
  }
  banned.forEach((pub) => {
    const row = document.createElement('div');
    row.className = 'banned-row';
    const label = document.createElement('span');
    label.textContent = '#' + identity.fingerprint(pub);
    const unban = document.createElement('button');
    unban.textContent = 'Desbanir';
    unban.onclick = () => unbanUser(pub);
    row.append(label, unban);
    list.append(row);
  });
  openModal('bannedModal');
}
async function unbanUser(pub) {
  const sp = getSpace(currentSpaceId);
  if (!store.isOwner(sp)) return;
  sp.banned = (sp.banned || []).filter((p) => p !== pub);
  await commitManifest(sp);
  openBanned();
}

let editingSpaceId = null;
let pendingSpaceImage = null;

function renderSpacePreview() {
  const el = $('spacePreview');
  if (pendingSpaceImage) {
    el.style.backgroundImage = `url(${pendingSpaceImage})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundColor = 'transparent';
    el.textContent = '';
    $('spacePhotoRemove').style.display = '';
  } else {
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = '#444';
    el.textContent = $('spaceIconInput').value.trim() || initialOf($('spaceNameInput').value || '#');
    $('spacePhotoRemove').style.display = 'none';
  }
}
function openSpaceCreate() {
  editingSpaceId = null;
  pendingSpaceImage = null;
  $('spaceModalTitle').textContent = 'Novo servidor';
  $('spaceCreate').textContent = 'Criar';
  $('spaceNameInput').value = '';
  $('spaceIconInput').value = '';
  renderSpacePreview();
  openModal('spaceModal');
  $('spaceNameInput').focus();
}
function openSpaceEdit(sp) {
  if (!sp || !store.canEdit(sp)) return;
  editingSpaceId = sp.id;
  pendingSpaceImage = sp.image || null;
  $('spaceModalTitle').textContent = 'Editar servidor';
  $('spaceCreate').textContent = 'Salvar';
  $('spaceNameInput').value = sp.name;
  $('spaceIconInput').value = sp.icon || '';
  renderSpacePreview();
  openModal('spaceModal');
}
$('spaceIconInput').oninput = () => {
  if (!pendingSpaceImage) renderSpacePreview();
};
$('spaceNameInput').oninput = () => {
  if (!pendingSpaceImage) renderSpacePreview();
};
$('spacePhotoBtn').onclick = () => $('spacePhotoInput').click();
$('spacePhotoInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingSpaceImage = await imageFileToAvatar(file);
    renderSpacePreview();
  } catch (err) {
    pushSys('foto: ' + err.message);
  }
  e.target.value = '';
};
$('spacePhotoRemove').onclick = () => {
  pendingSpaceImage = null;
  renderSpacePreview();
};
$('spaceCancel').onclick = () => closeModal('spaceModal');
$('spaceCreate').onclick = async () => {
  const name = $('spaceNameInput').value.trim();
  if (!name) return;
  const icon = $('spaceIconInput').value.trim();
  if (editingSpaceId) {
    const sp = getSpace(editingSpaceId);
    if (!sp || !store.canEdit(sp)) return;
    sp.name = name;
    sp.icon = icon;
    sp.image = pendingSpaceImage || '';
    await commitManifest(sp);
    closeModal('spaceModal');
    renderRail();
    renderChannels();
  } else {
    const sp = await store.createSpace(name, icon, pendingSpaceImage || '');
    spaces.push(sp);
    store.saveSpaces(spaces);
    startDiscovery(sp);
    closeModal('spaceModal');
    selectSpace(sp.id);
  }
};

$('inviteCancel').onclick = () => closeModal('inviteModal');
$('inviteJoin').onclick = async () => {
  const code = $('inviteInput').value.trim();
  if (!code) return;
  const btn = $('inviteJoin');
  btn.disabled = true;
  btn.textContent = 'Procurando...';
  $('inviteError').style.display = 'none';
  const res = await joinByInvite(code);
  btn.disabled = false;
  btn.textContent = 'Entrar';
  if (res === 'ok' || res === 'have') {
    $('inviteInput').value = '';
    $('inviteInput').classList.remove('invalid');
    closeModal('inviteModal');
  } else {
    $('inviteInput').classList.add('invalid');
    $('inviteError').style.display = '';
  }
};
$('inviteInput').oninput = () => {
  $('inviteInput').classList.remove('invalid');
  $('inviteError').style.display = 'none';
};

let pendingChannelType = 'text';
function openChannelModal(type) {
  pendingChannelType = type || 'text';
  document.querySelector(`input[name="chType"][value="${pendingChannelType}"]`).checked = true;
  openModal('channelModal');
  $('channelNameInput').focus();
}
$('channelCancel').onclick = () => closeModal('channelModal');
$('channelCreate').onclick = async () => {
  const name = $('channelNameInput').value.trim();
  if (!name) return;
  const type = document.querySelector('input[name="chType"]:checked').value;
  const sp = getSpace(currentSpaceId);
  if (!store.canEdit(sp)) return; // só o dono edita servidores com dono
  sp.channels.push(store.createChannel(name, type));
  if (store.isOwned(sp)) await store.bumpAndSign(sp); // reassina + versão nova
  store.saveSpaces(spaces);
  broadcastManifest(sp.id); // propaga aos peers conectados
  $('channelNameInput').value = '';
  closeModal('channelModal');
  renderChannels();
};

$('btnSpaceMenu').onclick = () => {
  const sp = getSpace(currentSpaceId);
  const role = store.isOwner(sp) ? ' · você é o dono' : sp.owner ? ' · membro' : ' · público';
  $('spaceMenuTitle').textContent = sp.name + role;
  $('menuAddChannel').style.display = store.canEdit(sp) ? '' : 'none';
  $('menuRenameSpace').style.display = store.canEdit(sp) ? '' : 'none';
  $('menuBanned').style.display = store.isOwner(sp) ? '' : 'none';
  $('inviteCopied').style.display = 'none';
  openModal('spaceMenuModal');
};
$('spaceMenuClose').onclick = () => closeModal('spaceMenuModal');
$('menuAddChannel').onclick = () => {
  closeModal('spaceMenuModal');
  openChannelModal('text');
};
$('menuRenameSpace').onclick = () => {
  closeModal('spaceMenuModal');
  openSpaceEdit(getSpace(currentSpaceId));
};
$('menuBanned').onclick = () => {
  closeModal('spaceMenuModal');
  openBanned();
};
$('bannedClose').onclick = () => closeModal('bannedModal');

// ---- Perfil: editar o meu / ver o de outro ------------------------------
let pendingAvatar = null;
function openMyProfile() {
  applyAvatarEl($('profileAvatar'), 'local');
  $('profileNick').textContent = myNick();
  $('profileFp').textContent = '#' + identity.fingerprint();
  $('profileNickInput').value = myNick();
  $('profileBio').value = profile.bio || '';
  $('bioCount').textContent = `${($('profileBio').value || '').length}/100`;
  pendingAvatar = null;
  $('profileEdit').style.display = '';
  $('profileView').style.display = 'none';
  openModal('profileModal');
}
let profileViewPub = null;
let profileViewNick = null;
function openPeerProfile(pid) {
  applyAvatarEl($('profileAvatar'), pid);
  $('profileNick').textContent = nickOf(pid) + (verifiedOf(pid) ? ' ✓' : '');
  $('profileFp').textContent = pubOf(pid) ? '#' + identity.fingerprint(pubOf(pid)) : '';
  $('profileBioView').textContent = bioOf(pid) || 'Sem bio.';
  profileViewPub = pubOf(pid);
  profileViewNick = nickOf(pid);
  // botão de DM só para outros usuários com chave conhecida
  $('profileMessage').style.display = profileViewPub && profileViewPub !== identity.pub() ? '' : 'none';
  $('profileEdit').style.display = 'none';
  $('profileView').style.display = '';
  openModal('profileModal');
}
$('profileMessage').onclick = () => {
  if (!profileViewPub) return;
  closeModal('profileModal');
  startDM(profileViewPub, profileViewNick);
};
$('meBar').querySelector('.me-info').onclick = openMyProfile;
$('profileCancel').onclick = () => closeModal('profileModal');
$('profileViewClose').onclick = () => closeModal('profileModal');
$('profileAvatarBtn').onclick = () => $('profileAvatarInput').click();
$('profileAvatarInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingAvatar = await imageFileToAvatar(file);
    $('profileAvatar').style.backgroundImage = `url(${pendingAvatar})`;
    $('profileAvatar').style.backgroundSize = 'cover';
    $('profileAvatar').style.backgroundPosition = 'center';
    $('profileAvatar').textContent = '';
  } catch (err) {
    pushSys('avatar: ' + err.message);
  }
};
$('profileBio').oninput = () => {
  $('bioCount').textContent = `${$('profileBio').value.length}/100`;
};
$('profileSave').onclick = () => {
  const nick = $('profileNickInput').value.trim();
  if (nick) store.setNick(nick);
  profile.bio = $('profileBio').value.trim();
  if (pendingAvatar) profile.avatar = pendingAvatar;
  saveProfile();
  closeModal('profileModal');
  renderMeBar();
  refreshTileLabels('local');
  renderChannels();
  renderStage();
  broadcastIdentity(); // peers recebem o novo perfil
};
$('menuCopyInvite').onclick = () => {
  closeModal('spaceMenuModal');
  const sp = getSpace(currentSpaceId);
  $('inviteCode').value = store.encodeInvite(sp);
  $('inviteCopiedMsg').style.display = 'none';
  openModal('inviteShareModal');
};
$('inviteCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('inviteCode').value);
    $('inviteCopiedMsg').style.display = '';
  } catch (e) {
    $('inviteCode').select();
  }
};
$('inviteShareClose').onclick = () => closeModal('inviteShareModal');
$('welcomeCreate').onclick = openSpaceCreate;
$('welcomeJoin').onclick = () => openModal('inviteModal');
$('menuLeaveSpace').onclick = () => {
  if (spaces.length <= 1) return; // não sair do último
  spaces = spaces.filter((s) => s.id !== currentSpaceId);
  store.saveSpaces(spaces);
  closeModal('spaceMenuModal');
  selectSpace(spaces[0].id);
};

// ========================================================================
//  MANIFESTO DE SERVIDOR (gossip assinado — só servidores com dono)
// ========================================================================
function manifestSync(room, spaceId) {
  const [sendMan, getMan] = room.makeAction('manifest');
  getMan((incoming) => adoptManifest(incoming, spaceId));
  return (target) => {
    const s = getSpace(spaceId);
    if (s && s.owner) sendMan(s, target); // sem target = broadcast
  };
}

async function adoptManifest(incoming, spaceId) {
  if (!incoming || incoming.id !== spaceId || !incoming.owner) return;
  const cur = getSpace(spaceId);
  if (cur) {
    if (cur.owner && incoming.owner !== cur.owner) return; // dono diferente
    if ((incoming.version || 1) <= (cur.version || 1)) return; // não é mais novo
  }
  if (!(await store.verifyManifest(incoming))) return; // assinatura inválida
  replaceSpace(incoming);
}

function replaceSpace(sp) {
  // fui banido deste servidor? saio dele (cooperativo)
  if ((sp.banned || []).includes(identity.pub())) {
    if (voice && voice.spaceId === sp.id) leaveVoice();
    spaces = spaces.filter((s) => s.id !== sp.id);
    store.saveSpaces(spaces);
    if (currentSpaceId === sp.id && spaces[0]) selectSpace(spaces[0].id);
    renderRail();
    return;
  }
  const i = spaces.findIndex((s) => s.id === sp.id);
  if (i >= 0) spaces[i] = sp;
  else spaces.push(sp);
  store.saveSpaces(spaces);
  startDiscovery(sp);
  enforceBans();
  renderRail();
  if (currentSpaceId === sp.id) {
    renderChannels();
    const { spaceId, channelId } = parseKey(viewKey || ':');
    if (spaceId === sp.id && !getChannel(spaceId, channelId)) {
      const first = sp.channels.find((c) => c.type === 'text') || sp.channels[0];
      if (first) selectChannel(sp.id, first.id);
    }
  }
}

function broadcastManifest(spaceId) {
  if (voice && voice.spaceId === spaceId && voice.announceMan) voice.announceMan();
  if (textRoomKey && parseKey(textRoomKey).spaceId === spaceId && textAnnounceMan) textAnnounceMan();
  const dr = discoveryRooms[spaceId];
  if (dr && dr.__sendMan) {
    const s = getSpace(spaceId);
    if (s && s.owner) dr.__sendMan(s);
  }
}

// Sala de descoberta por servidor ('srv:<id>'): serve o manifesto assinado a
// quem entra só com o id (convite curto). Mantida enquanto o app está aberto.
function startDiscovery(sp) {
  if (!sp || !sp.owner || discoveryRooms[sp.id]) return;
  const room = joinRoom(
    { appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } },
    'srv:' + sp.id
  );
  const [sendMan, getMan] = room.makeAction('manifest');
  room.__sendMan = sendMan;
  getMan((incoming) => adoptManifest(incoming, sp.id));
  room.onPeerJoin(() => {
    const s = getSpace(sp.id);
    if (s && s.owner) sendMan(s);
  });
  discoveryRooms[sp.id] = room;
}
function startAllDiscovery() {
  spaces.forEach((sp) => sp.owner && startDiscovery(sp));
}

// Entra num servidor pelo id curto: junta na sala de descoberta e adota o
// manifesto assinado que um membro online enviar.
function joinByInvite(code) {
  code = (code || '').trim();
  if (!code) return Promise.resolve('empty');
  if (getSpace(code)) {
    selectSpace(code);
    return Promise.resolve('have');
  }
  return new Promise((resolve) => {
    let done = false;
    const room = joinRoom(
      { appId: APP_ID, rtcConfig: { iceServers: buildIceServers() } },
      'srv:' + code
    );
    const [sendMan, getMan] = room.makeAction('manifest');
    room.__sendMan = sendMan;
    getMan(async (incoming) => {
      if (done || !incoming || incoming.id !== code || !incoming.owner) return;
      if (!(await store.verifyManifest(incoming))) return;
      done = true;
      discoveryRooms[code] = room; // mantém como sala de descoberta
      room.onPeerJoin(() => {
        const s = getSpace(code);
        if (s && s.owner) sendMan(s);
      });
      replaceSpace(incoming);
      selectSpace(code);
      resolve('ok');
    });
    setTimeout(() => {
      if (!done) {
        try {
          room.leave();
        } catch (e) {}
        resolve('notfound');
      }
    }, 12000);
  });
}

// ========================================================================
//  UTIL
// ========================================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
// ---- Perfil (avatar/bio) ------------------------------------------------
let profile = {};
try {
  profile = JSON.parse(localStorage.getItem('p2pProfile') || '{}');
} catch (e) {}
function saveProfile() {
  localStorage.setItem('p2pProfile', JSON.stringify(profile));
}
function avatarUrlOf(pid) {
  return pid === 'local' ? profile.avatar || '' : voiceParticipants[pid]?.avatar || '';
}
function bioOf(pid) {
  return pid === 'local' ? profile.bio || '' : voiceParticipants[pid]?.bio || '';
}
// aplica avatar de imagem (se houver) ou inicial+cor no elemento .avatar
function applyAvatarEl(el, pid) {
  const url = avatarUrlOf(pid);
  if (url) {
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundColor = 'transparent';
    el.textContent = '';
  } else {
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = `hsl(${hueOf(colorKey(pid))} 55% 45%)`;
    el.textContent = initialOf(nickOf(pid));
  }
}
// aplica a foto (se houver) ou o emoji/letra no botão de servidor
function applyServerIcon(el, sp) {
  if (sp.image) {
    el.style.backgroundImage = `url(${sp.image})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
  } else {
    el.style.backgroundImage = 'none';
    el.textContent = sp.icon || initialOf(sp.name);
  }
}

// converte um arquivo de imagem em WebP quadrado (avatar leve)
async function imageFileToAvatar(file) {
  const bm = await createImageBitmap(file);
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const s = Math.min(bm.width, bm.height);
  ctx.drawImage(bm, (bm.width - s) / 2, (bm.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/webp', 0.8);
}
// converte imagem para WebP redimensionado (envio no chat)
async function imageFileToChat(file) {
  const bm = await createImageBitmap(file);
  const max = 1280;
  const scale = Math.min(1, max / Math.max(bm.width, bm.height));
  const w = Math.round(bm.width * scale);
  const h = Math.round(bm.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bm, 0, 0, w, h);
  return c.toDataURL('image/webp', 0.7);
}
// conteúdo assinável de uma mensagem (texto e/ou imagem)
function signContent(text, img) {
  return (text || '') + ' ' + (img || '');
}

// payload de identidade (inclui avatar/bio, tudo atrelado à chave verificada)
async function identPayload() {
  const sig = await identity.sign(identity.pub());
  return { pub: identity.pub(), nick: myNick(), sig, avatar: profile.avatar || '', bio: profile.bio || '' };
}
// reanuncia minha identidade em todas as salas ativas (após mudar perfil/nick)
let textAnnounceIdent = null;
let vchatAnnounceIdent = null;
function broadcastIdentity() {
  if (voice && voice.announceIdent) voice.announceIdent();
  if (textAnnounceIdent) textAnnounceIdent();
  if (vchatAnnounceIdent) vchatAnnounceIdent();
}

function renderMeBar() {
  $('meNick').textContent = myNick();
  $('meNick').title = 'Sua identidade · #' + identity.fingerprint();
  applyAvatarEl($('meAvatar'), 'local');
}

// ========================================================================
//  BOOT + GATE DE APELIDO
// ========================================================================
function boot() {
  renderMeBar();
  renderRail();
  startAllDiscovery(); // mantém os servidores "descobríveis" por id
  startInbox(); // recebe convites de DM
  dmList.forEach((d) => joinDMRoom(d.pub, d.nick)); // DMs ativas em 2º plano
  if (!spaces.length) {
    mode = 'server';
    renderChannels();
    showWelcome();
    return;
  }
  currentSpaceId = spaces[0].id;
  renderChannels();
  const sp = getSpace(currentSpaceId);
  const first = sp.channels.find((c) => c.type === 'text') || sp.channels[0];
  if (first) selectChannel(currentSpaceId, first.id);
  else showEmpty();
}

function showWelcome() {
  $('welcomeView').classList.remove('hidden');
  textView.classList.add('hidden');
  voiceView.classList.add('hidden');
  emptyView.classList.add('hidden');
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

(async () => {
  try {
    await identity.init(); // gera/carrega o keypair antes de tudo
    console.log('[id] identidade #' + identity.fingerprint());
  } catch (err) {
    console.error('[id] falha ao iniciar identidade:', err);
  }
  // aplica a config de entrada (mic/surdo) salva
  micEnabled = !settings.micMuted;
  deafened = settings.deafened;
  updateMeControls();
  // servidor de teste fixo (público) só quando pedido via env, para 2 instâncias
  if (params.get('seed') && !getSpace('testroom')) {
    spaces.push({
      id: 'testroom',
      name: 'Test',
      icon: '🧪',
      channels: [
        { id: 'geral', name: 'geral', type: 'text' },
        { id: 'voz', name: 'Voz', type: 'voice' },
      ],
    });
  }
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
})();
