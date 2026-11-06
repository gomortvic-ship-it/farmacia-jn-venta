/* db.js — almacenamiento local persistente (IndexedDB). Las ventas y turnos se guardan aquí y
   NO se borran aunque se cierre la app. Cada venta nace con un id único (UUID) que servirá para
   evitar duplicados cuando se sincronice con el servidor (Etapa 2). */
(function (root) {
  'use strict';
  var NAME = 'farmacia-jn', VERSION = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(NAME, VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        db.createObjectStore('meta', { keyPath: 'k' });
        db.createObjectStore('turnos', { keyPath: 'id' });
        var v = db.createObjectStore('ventas', { keyPath: 'id' });
        v.createIndex('turnoId', 'turnoId'); v.createIndex('sync', 'sync');
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function txDone(tx) { return new Promise(function (res, rej) { tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error || new Error('abort')); }; }); }

  function uuid() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  var api = {
    uuid: uuid,
    getMeta: function (k) { return open().then(function (db) { return req(db.transaction('meta').objectStore('meta').get(k)); }).then(function (r) { return r ? r.v : null; }); },
    setMeta: function (k, v) { return open().then(function (db) { var tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ k: k, v: v }); return txDone(tx); }); },
    delMeta: function (k) { return open().then(function (db) { var tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete(k); return txDone(tx); }); },
    putTurno: function (t) { return open().then(function (db) { var tx = db.transaction('turnos', 'readwrite'); tx.objectStore('turnos').put(t); return txDone(tx); }); },
    getTurno: function (id) { return open().then(function (db) { return req(db.transaction('turnos').objectStore('turnos').get(id)); }); },
    allTurnos: function () { return open().then(function (db) { return req(db.transaction('turnos').objectStore('turnos').getAll()); }); },
    /** Código corto del dispositivo (parte del folio). */
    deviceCode: function () {
      return api.getMeta('deviceCode').then(function (c) {
        if (c) return c;
        c = Math.random().toString(36).slice(2, 6).toUpperCase();
        return api.setMeta('deviceCode', c).then(function () { return c; });
      });
    },
    /**
     * Guarda una venta de forma atómica: asigna folio consecutivo del dispositivo y la escribe.
     * Si ya existe una venta con el mismo id (reintento), NO la duplica y devuelve la existente.
     * La promesa se resuelve solo cuando IndexedDB confirmó la escritura.
     */
    addVenta: function (venta) {
      return api.deviceCode().then(function (dc) {
        return open().then(function (db) {
          var tx = db.transaction(['meta', 'ventas'], 'readwrite');
          var metaS = tx.objectStore('meta'), ventasS = tx.objectStore('ventas');
          var out = { venta: null, duplicada: false };
          ventasS.get(venta.id).onsuccess = function (e) {
            if (e.target.result) { out.venta = e.target.result; out.duplicada = true; return; }
            metaS.get('folioSeq').onsuccess = function (e2) {
              var seq = (e2.target.result ? e2.target.result.v : 0) + 1;
              metaS.put({ k: 'folioSeq', v: seq });
              var v = Object.assign({}, venta, { folio: dc + '-' + ('0000' + seq).slice(-5), sync: 'pendiente' });
              ventasS.add(v); out.venta = v;
            };
          };
          return txDone(tx).then(function () { return out; });
        });
      });
    },
    ventasDeTurno: function (turnoId) {
      return open().then(function (db) { return req(db.transaction('ventas').objectStore('ventas').index('turnoId').getAll(turnoId)); })
        .then(function (a) { return a.sort(function (x, y) { return x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0; }); });
    },
    allVentas: function () { return open().then(function (db) { return req(db.transaction('ventas').objectStore('ventas').getAll()); }); },
    countPendientes: function () { return open().then(function (db) { return req(db.transaction('ventas').objectStore('ventas').index('sync').count('pendiente')); }); }
  };
  root.FDB = api;
})(window);
