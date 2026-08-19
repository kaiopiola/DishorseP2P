// Polyfill dos métodos hex/base64 de Uint8Array (proposta TC39 "Uint8Array
// to/from hex and base64"). Presentes no Chromium >= 140; ausentes em versões
// mais antigas (Electron < ~37). As libs de cripto @noble usadas pela
// estratégia nostr do Trystero chamam bytes.toHex() nativamente, sem fallback.
// Este módulo é importado ANTES do trystero para que os métodos já existam
// quando @noble/hashes faz sua detecção de recurso em tempo de carga.
(() => {
  const proto = Uint8Array.prototype;

  const def = (obj, name, value) => {
    if (typeof obj[name] !== 'function') {
      Object.defineProperty(obj, name, { value, writable: true, configurable: true });
    }
  };

  def(proto, 'toHex', function () {
    let s = '';
    for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0');
    return s;
  });

  def(Uint8Array, 'fromHex', function (hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) {
      throw new SyntaxError('hex string de tamanho inválido');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  });

  def(proto, 'setFromHex', function (hex) {
    const bytes = Uint8Array.fromHex(hex);
    this.set(bytes);
    return { read: hex.length, written: bytes.length };
  });

  def(proto, 'toBase64', function () {
    let bin = '';
    for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
    return btoa(bin);
  });

  def(Uint8Array, 'fromBase64', function (b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  });
})();
