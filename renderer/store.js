// Camada de dados: identidade, servidores (spaces) e canais.
// Persistência local em localStorage.
//
// Servidores criados pelo usuário são "owned": têm `owner` (chave pública do
// criador), `nonce`, `version` e `sig` (assinatura do dono sobre o manifesto).
// O `id` deriva de hash(owner + nonce), garantindo unicidade e amarrando o dono.
// Só o dono edita; peers verificam a assinatura e adotam a maior versão válida.
// O servidor-semente "Daggerfall" é um espaço público legado, sem dono.

import * as identity from './identity.js';

const SPACES_KEY = 'p2pSpaces';
const NICK_KEY = 'p2pNick';

// gera ids curtos sem depender de Math.random em excesso (ok no renderer)
export function genId(prefix = '') {
  const s = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${s}` : s;
}

// ---- Identidade (apelido por enquanto) ----------------------------------
export function getNick() {
  return localStorage.getItem(NICK_KEY) || '';
}
export function setNick(nick) {
  localStorage.setItem(NICK_KEY, nick);
}

// ---- Servidores / canais ------------------------------------------------
// App inicia VAZIO (sem servidor-semente). O usuário cria (+) ou entra por convite.
export function loadSpaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(SPACES_KEY));
    if (Array.isArray(raw)) return raw;
  } catch (e) {}
  return [];
}

export function saveSpaces(spaces) {
  localStorage.setItem(SPACES_KEY, JSON.stringify(spaces));
}

// Cria um servidor "owned": id derivado do dono, manifesto assinado.
export async function createSpace(name, icon) {
  const owner = identity.pub();
  const nonce = genId('n');
  const id = await identity.hashId(owner + ':' + nonce);
  const sp = {
    id,
    owner,
    nonce,
    version: 1,
    name: name || 'Novo servidor',
    icon: icon || (name ? name.trim().charAt(0).toUpperCase() : '#'),
    banned: [], // chaves públicas banidas (cooperativo)
    channels: [
      { id: genId('c'), name: 'geral', type: 'text' },
      { id: genId('c'), name: 'Sala de Voz', type: 'voice' },
    ],
  };
  sp.sig = await signManifest(sp);
  return sp;
}

export function createChannel(name, type) {
  return { id: genId('c'), name: name || 'novo-canal', type: type || 'text' };
}

// ---- Manifesto assinado -------------------------------------------------
// Serialização canônica (campos ordenados) para assinar/verificar de forma estável.
function canon(sp) {
  return JSON.stringify({
    id: sp.id,
    owner: sp.owner,
    nonce: sp.nonce,
    version: sp.version,
    name: sp.name,
    icon: sp.icon,
    banned: sp.banned || [],
    channels: sp.channels,
  });
}

export function isOwned(sp) {
  return !!sp.owner;
}
export function isOwner(sp) {
  return sp.owner === identity.pub();
}
// Dono edita; espaço público legado (sem dono) é editável localmente.
export function canEdit(sp) {
  return !sp.owner || isOwner(sp);
}

export async function signManifest(sp) {
  return identity.sign(canon(sp));
}

// (Re)assina após uma mudança do dono, incrementando a versão.
export async function bumpAndSign(sp) {
  sp.version = (sp.version || 1) + 1;
  sp.sig = await signManifest(sp);
  return sp;
}

// Verifica: id derivado do dono + assinatura válida do dono sobre o manifesto.
export async function verifyManifest(sp) {
  if (!sp.owner || !sp.sig) return false;
  const expectedId = await identity.hashId(sp.owner + ':' + sp.nonce);
  if (sp.id !== expectedId) return false;
  return identity.verify(sp.owner, sp.sig, canon(sp));
}

// nome de sala Trystero para um canal (namespacing por servidor+canal)
export function channelRoomId(spaceId, channelId) {
  return `${spaceId}:${channelId}`;
}

// ---- Convites (compartilhar servidor) -----------------------------------
// O convite é o próprio id curto do servidor (ex.: "D5lgLLW4uPFXs-5w"). Quem
// entra usa esse id para descobrir o manifesto assinado via rede (sala 'srv:<id>').
export function encodeInvite(space) {
  return space.id;
}
