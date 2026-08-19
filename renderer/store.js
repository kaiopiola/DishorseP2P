// Camada de dados: identidade, servidores (spaces) e canais.
// Persistência local em localStorage. Identidade por chave criptográfica e
// histórico CRDT entram em incrementos futuros; por ora identidade = apelido.

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
function defaultSpaces() {
  return [
    {
      id: 'daggerfall',
      name: 'Daggerfall',
      icon: '🗡️',
      channels: [
        { id: 'geral', name: 'geral', type: 'text' },
        { id: 'random', name: 'random', type: 'text' },
        { id: 'voz', name: 'Sala de Voz', type: 'voice' },
      ],
    },
  ];
}

export function loadSpaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(SPACES_KEY));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (e) {}
  const seed = defaultSpaces();
  saveSpaces(seed);
  return seed;
}

export function saveSpaces(spaces) {
  localStorage.setItem(SPACES_KEY, JSON.stringify(spaces));
}

export function createSpace(name, icon) {
  return {
    id: genId('s'),
    name: name || 'Novo servidor',
    icon: icon || (name ? name.trim().charAt(0).toUpperCase() : '#'),
    channels: [
      { id: genId('c'), name: 'geral', type: 'text' },
      { id: genId('c'), name: 'Sala de Voz', type: 'voice' },
    ],
  };
}

export function createChannel(name, type) {
  return { id: genId('c'), name: name || 'novo-canal', type: type || 'text' };
}

// nome de sala Trystero para um canal (namespacing por servidor+canal)
export function channelRoomId(spaceId, channelId) {
  return `${spaceId}:${channelId}`;
}

// ---- Convites (compartilhar servidor) -----------------------------------
// Um convite carrega o manifesto do servidor (id, nome, ícone, canais).
export function encodeInvite(space) {
  const json = JSON.stringify({
    id: space.id,
    name: space.name,
    icon: space.icon,
    channels: space.channels,
  });
  return btoa(unescape(encodeURIComponent(json)));
}

export function decodeInvite(code) {
  try {
    const json = decodeURIComponent(escape(atob(code.trim())));
    const space = JSON.parse(json);
    if (!space.id || !Array.isArray(space.channels)) return null;
    return space;
  } catch (e) {
    return null;
  }
}
