// Identidade criptográfica do usuário.
// Keypair ECDSA P-256 gerado na 1ª vez e guardado no IndexedDB. A chave privada
// é reimportada como NÃO-EXTRAÍVEL antes de persistir: pode assinar, mas não
// pode ser exportada nem exfiltrada por JS. A chave pública (bytes crus) é o
// identificador estável do usuário — o apelido é só conteúdo por cima dela.

const DB_NAME = 'p2p-identity';
const STORE = 'keys';
const ALGO = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGO = { name: 'ECDSA', hash: 'SHA-256' };

let _priv = null; // CryptoKey (não-extraível)
let _pub = ''; // base64url da chave pública crua
const _pubCache = {}; // base64url -> CryptoKey importada (verificação)
const enc = new TextEncoder();

// ---- IndexedDB (promisificado) -----------------------------------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbGet(db, k) {
  return new Promise((res, rej) => {
    const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function idbPut(db, k, v) {
  return new Promise((res, rej) => {
    const rq = db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k);
    rq.onsuccess = () => res();
    rq.onerror = () => rej(rq.error);
  });
}

// ---- base64url ----------------------------------------------------------
function abToB64u(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToU8(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// ---- API ----------------------------------------------------------------
export async function init() {
  const db = await idb();
  let rec = await idbGet(db, 'self');
  if (!rec) {
    // gera extraível, exporta pub cru, reimporta a privada como não-extraível
    const kp = await crypto.subtle.generateKey(ALGO, true, ['sign', 'verify']);
    const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const priv = await crypto.subtle.importKey('pkcs8', pkcs8, ALGO, false, ['sign']);
    rec = { priv, pub: rawPub };
    await idbPut(db, 'self', rec);
  }
  _priv = rec.priv;
  _pub = abToB64u(rec.pub);
  return { pub: _pub };
}

export function pub() {
  return _pub;
}

// Hash curto (SHA-256 → base64url, 16 chars) para derivar ids estáveis, p.ex.
// o id de um servidor a partir de hash(ownerPub + nonce).
export async function hashId(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return abToB64u(d).slice(0, 16);
}

// Fingerprint curto para exibição (não é a identidade inteira).
export function fingerprint(pubB64 = _pub) {
  return (pubB64 || '').slice(0, 8);
}

export async function sign(str) {
  const sig = await crypto.subtle.sign(SIGN_ALGO, _priv, enc.encode(str));
  return abToB64u(sig);
}

async function importPub(pubB64) {
  if (_pubCache[pubB64]) return _pubCache[pubB64];
  const key = await crypto.subtle.importKey('raw', b64uToU8(pubB64), ALGO, false, ['verify']);
  _pubCache[pubB64] = key;
  return key;
}

export async function verify(pubB64, sigB64, str) {
  try {
    const key = await importPub(pubB64);
    return await crypto.subtle.verify(SIGN_ALGO, key, b64uToU8(sigB64), enc.encode(str));
  } catch (e) {
    return false;
  }
}
