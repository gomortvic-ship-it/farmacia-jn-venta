/* search.js — normalización de texto, búsqueda y autocompletado.
   Funciona en el navegador (window.OFSearch) y en Node (module.exports) para pruebas. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OFSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Minúsculas, sin acentos, espacios colapsados. */
  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }
  /** Para códigos: solo letras/números, en mayúsculas. */
  function normalizeCode(s) {
    return String(s == null ? '' : s).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  }
  function stripZeros(c) { return c.replace(/^0+(?=.)/, ''); }

  /** Prepara un índice (campos normalizados precalculados) sobre el catálogo. */
  function buildIndex(items) {
    const byCode = new Map();
    const entries = items.map(function (it, pos) {
      const code = normalizeCode(it.codigo);
      const e = {
        pos: pos, item: it, code: code,
        nd: normalize(it.descripcion), ns: normalize(it.sal)
      };
      e.all = e.nd + ' ' + e.ns;
      if (code) {
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(pos);
      }
      return e;
    });
    return { items: items, entries: entries, byCode: byCode };
  }

  /** Busca por código exacto. Tolera ceros a la izquierda (EAN-13 vs UPC-A). Devuelve posiciones. */
  function findByCode(index, raw) {
    const c = normalizeCode(raw);
    if (!c) return [];
    if (index.byCode.has(c)) return index.byCode.get(c).slice();
    const z = stripZeros(c);
    const out = [];
    index.byCode.forEach(function (positions, code) {
      if (stripZeros(code) === z) out.push.apply(out, positions);
    });
    return out;
  }

  /**
   * Busca por nombre, sustancia o código.
   * Devuelve [{pos, item, score, match}] ordenado por relevancia (y por orden maestro al empatar).
   */
  function search(index, query, limit) {
    limit = limit || 12;
    const q = normalize(query);
    if (!q) return [];
    const qc = normalizeCode(query);
    const digits = /^[0-9]+$/.test(qc);
    const tokens = q.split(' ').filter(Boolean);
    const res = [];
    const exact = new Set(digits || qc.length >= 3 ? findByCode(index, qc) : []);

    for (let i = 0; i < index.entries.length; i++) {
      const e = index.entries[i];
      let score = 0, match = '';
      if (exact.has(e.pos)) { score = 1000; match = 'codigo'; }
      else if (digits && qc.length >= 4 && e.code.indexOf(qc) !== -1) {
        score = e.code.startsWith(qc) ? 600 : 550; match = 'codigo';
      } else {
        let ok = true;
        for (let t = 0; t < tokens.length; t++) {
          if (e.all.indexOf(tokens[t]) === -1) { ok = false; break; }
        }
        if (!ok) continue;
        if (e.nd.startsWith(q)) { score = 500; match = 'nombre'; }
        else if (e.ns.startsWith(q)) { score = 400; match = 'sal'; }
        else if (e.nd.indexOf(q) !== -1) { score = 320; match = 'nombre'; }
        else if (e.ns.indexOf(q) !== -1) { score = 300; match = 'sal'; }
        else if (tokens.every(function (t) { return e.nd.indexOf(t) !== -1; })) { score = 250; match = 'nombre'; }
        else { score = 200; match = 'sal'; }
        // bonus: coincidencia al inicio de una palabra
        if (tokens.length && (' ' + e.nd).indexOf(' ' + tokens[0]) !== -1) score += 10;
      }
      res.push({ pos: e.pos, item: e.item, score: score, match: match });
    }
    res.sort(function (a, b) { return b.score - a.score || a.pos - b.pos; });
    const total = res.length;
    const top = res.slice(0, limit);
    top.total = total;
    return top;
  }

  return { normalize: normalize, normalizeCode: normalizeCode, buildIndex: buildIndex, findByCode: findByCode, search: search };
});
