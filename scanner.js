/* scanner.js — lector de códigos de barras con la cámara (ZXing 0.21.3, copia local en ).
   Requiere HTTPS (o localhost). La biblioteca se carga solo al abrir el lector. */
(function (root) {
  'use strict';
  var ZX_SRC = 'zxing-library-0.21.3.min.js';
  var controls = null, reader = null, active = false, loading = null, gen = 0;

  function loadLib() {
    if (root.ZXing) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = ZX_SRC; s.onload = res;
      s.onerror = function () { loading = null; rej(new Error('lib')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** Traduce errores de cámara a mensajes claros. */
  function explain(err) {
    var n = err && err.name;
    if (!window.isSecureContext) return 'La cámara solo funciona desde una página segura (HTTPS). Escribe el código manualmente.';
    if (!supported()) return 'Este navegador no permite usar la cámara. Escribe el código manualmente.';
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permiso de cámara denegado. Actívalo en los ajustes del navegador para este sitio, o escribe el código manualmente.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No se encontró una cámara en este dispositivo. Escribe el código manualmente.';
    if (n === 'NotReadableError') return 'La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.';
    if (err && err.message === 'lib') return 'No se pudo cargar el lector (sin conexión). Escribe el código manualmente.';
    return 'No se pudo iniciar la cámara. Escribe el código manualmente.';
  }

  /**
   * start(video, onCode, onError): inicia la lectura. onCode(texto) se llama UNA vez con la primera lectura
   * válida y el lector se detiene. onError(mensaje) si no puede iniciar.
   */
  function start(video, onCode, onError) {
    stop();
    active = true;
    var my = ++gen;   // identifica esta sesión de escaneo (evita carreras al abrir/cerrar rápido)
    return loadLib().then(function () {
      if (!active || my !== gen) return;
      var Z = root.ZXing;
      var hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
        Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A,
        Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39
      ]);
      var rd = reader = new Z.BrowserMultiFormatReader(hints, 150);
      var constraints = { audio: false, video: { facingMode: { ideal: 'environment' },
        width: { ideal: 1280 }, height: { ideal: 720 } } };
      return rd.decodeFromConstraints(constraints, video, function (result) {
        if (result && active && my === gen) {
          var text = result.getText();
          stop();
          onCode(text);
        }
      }).then(function (c) {
        if (!active || my !== gen) { try { c.stop(); } catch (e) {} return; }
        controls = c;
      });
    }).catch(function (err) { if (my !== gen) return; stop(); onError(explain(err)); });
  }

  function stop() {
    active = false; gen++;
    try { if (controls) controls.stop(); } catch (e) {}
    try { if (reader) reader.reset(); } catch (e) {}
    controls = null; reader = null;
    var v = document.getElementById('video');
    if (v && v.srcObject) {
      try { v.srcObject.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      v.srcObject = null;
    }
  }

  root.OFScanner = { start: start, stop: stop, supported: supported, explain: explain };
})(window);
