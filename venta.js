/* venta.js — Farmacia JN · Punto de venta (Etapa 1: venta, turnos, cobro, corte, sin internet).
   Todo se guarda en IndexedDB de este dispositivo. El servidor (Supabase) llega en la Etapa 2. */
(function () {
  'use strict';
  var SUCURSAL = 'Principal';
  var $ = function (id) { return document.getElementById(id); };
  var F = FCalc.fmt;

  var catalog = [], index = null, turno = null, cart = [], prod = null;
  var suggRes = [], suggActive = -1, timer = null, saving = false, closing = false, saleId = null, lastCierre = null;
  var saleMod = null, modoVisto = null;   // saleMod: modalidad congelada durante el cobro

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var toastT;
  function toast(msg, err) { var t = $('toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(function () { t.className = ''; }, 2800); }
  function showErr(id, msg) { var e = $(id); e.textContent = msg || ''; e.hidden = !msg; }
  function openModal(id) { $(id).hidden = false; document.body.classList.add('noscroll'); }
  function closeModal(id) { $(id).hidden = true; if ([].every.call(document.querySelectorAll('.modal'), function (m) { return m.hidden; })) document.body.classList.remove('noscroll'); }
  function fechaHora(iso) { var d = new Date(iso); return d.toLocaleDateString('es-MX') + ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); }
  function hora(iso) { return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); }
  function desktop() { return window.innerWidth >= 900; }

  /* ───────── Catálogo ───────── */
  function loadCatalog() {
    return fetch('data.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var fromCache = r.headers.get('X-From-Cache') === '1';
      return r.json().then(function (d) { return { d: d, fromCache: fromCache }; });
    }).then(function (res) {
      // data.json: CODIGO, SAL (sustancia / cómo está ordenado en el estante), PRODUCTO, PRECIO, DESCUENTO (solo se lee)
      catalog = res.d.map(function (x) { return { codigo: String(x.CODIGO), descripcion: String(x.PRODUCTO), sal: String(x.SAL || ''), precio: Number(x.PRECIO), descuento: Number(x.DESCUENTO) }; });
      index = OFSearch.buildIndex(catalog);
      $('cacheBanner').hidden = !res.fromCache;
      $('estadoBusqueda').textContent = catalog.length.toLocaleString('es-MX') + ' productos en el catálogo.';
    });
  }

  /* ───────── Turno ───────── */
  function modLabel(m) { return m === 'descuento' ? 'Descuento 25%' : 'Precio normal'; }
  /** Modalidad de HOY según la fecha del teléfono: lunes y jueves = descuento 25%; otros días = precio normal. */
  function hoyMod() { return FCalc.modalidadPara(new Date()); }
  var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  function hoyTexto() { return modLabel(hoyMod()) + ' · ' + DIAS[new Date().getDay()]; }

  function renderTurno() {
    var t = turno;
    $('hdrVendedor').textContent = t ? t.vendedor : '—';
    $('tVendedor').textContent = t ? t.vendedor : '—';
    $('tSucursal').textContent = t ? t.sucursal : '—';
    $('tEntrada').textContent = t ? fechaHora(t.horaEntrada) : '—';
    $('tFondo').textContent = t ? F(t.fondoCents) : '—';
    var p = $('tModalidad'); p.textContent = t ? hoyTexto() : '—'; p.className = 'pill' + (t && hoyMod() === 'descuento' ? ' desc' : '');
    modoVisto = hoyMod();
    $('buscador').disabled = !t; $('btnScan').disabled = !t;
  }

  function showTurnoModal() {
    $('mtSucursal').textContent = SUCURSAL; showErr('mtError', '');
    var h = $('mtHoy'); h.textContent = hoyTexto(); h.className = 'pill' + (hoyMod() === 'descuento' ? ' desc' : '');
    FDB.getMeta('nombres').then(function (n) {
      $('listaNombres').innerHTML = (n || []).map(function (x) { return '<option value="' + esc(x) + '">'; }).join('');
    });
    $('mtFondo').value = ''; openModal('modalTurno'); setTimeout(function () { $('mtNombre').focus(); }, 50);
  }

  $('formTurno').addEventListener('submit', function (e) {
    e.preventDefault();
    var nombre = $('mtNombre').value.replace(/\s+/g, ' ').trim();
    var fondo = FCalc.parseMoney($('mtFondo').value);
    if (!nombre) return showErr('mtError', 'Escribe tu nombre.');
    if (fondo === null) return showErr('mtError', 'Escribe el fondo inicial de caja (por ejemplo 500 o 500.00). Es obligatorio.');
    var t = { id: FDB.uuid(), sucursal: SUCURSAL, vendedor: nombre, fecha: ymd(new Date()), horaEntrada: new Date().toISOString(),
      fondoCents: fondo, dispositivo: (navigator.userAgent || '').slice(0, 120), estado: 'abierto', sync: 'pendiente' };
    FDB.putTurno(t).then(function () { return FDB.setMeta('turnoActivoId', t.id); })
      .then(function () { return FDB.getMeta('nombres'); })
      .then(function (n) { n = n || []; if (n.indexOf(nombre) === -1) n.push(nombre); return FDB.setMeta('nombres', n.slice(-30)); })
      .then(function () { turno = t; cart = []; prod = null; closeModal('modalTurno'); renderAll(); toast('Turno iniciado · ' + hoyTexto()); })
      .catch(function () { showErr('mtError', 'No se pudo guardar el turno en este dispositivo. No se inició.'); });
  });

  /* ───────── Búsqueda ───────── */
  function precioAplica(p) { return FCalc.unitCents(p, hoyMod()); }

  function onInput() {
    clearTimeout(timer); timer = setTimeout(runSearch, 60);
  }
  function runSearch() {
    var q = $('buscador').value.trim();
    if (!index) return;
    if (!q) { hideSugg(); $('estadoBusqueda').textContent = catalog.length.toLocaleString('es-MX') + ' productos en el catálogo.'; return; }
    suggRes = OFSearch.search(index, q, 40); suggActive = -1;
    if (!suggRes.length) { hideSugg(); $('estadoBusqueda').textContent = 'Sin resultados para “' + q + '”.'; return; }
    $('estadoBusqueda').textContent = suggRes.total + (suggRes.total === 1 ? ' resultado' : ' resultados') + (suggRes.total > suggRes.length ? ' (mostrando ' + suggRes.length + '; escribe más para acotar)' : '');
    $('sugerencias').innerHTML = suggRes.map(function (r, i) {
      return '<div class="sug" role="option" data-i="' + i + '"><b>' + esc(r.item.descripcion) + '</b><small class="sal">📍 ' + esc(r.item.sal) + '</small><small>' + esc(r.item.codigo) + ' · <span class="p">' + F(precioAplica(r.item)) + '</span></small></div>';
    }).join('');
    $('sugerencias').hidden = false;
  }
  function hideSugg() { $('sugerencias').hidden = true; $('sugerencias').innerHTML = ''; suggRes = []; suggActive = -1; }
  function hl(i) { var c = $('sugerencias').children; for (var k = 0; k < c.length; k++) c[k].classList.toggle('active', k === i); suggActive = i; if (c[i]) c[i].scrollIntoView({ block: 'nearest' }); }

  $('buscador').addEventListener('input', onInput);
  $('buscador').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' && suggRes.length) { e.preventDefault(); hl(Math.min(suggActive + 1, suggRes.length - 1)); }
    else if (e.key === 'ArrowUp' && suggRes.length) { e.preventDefault(); hl(Math.max(suggActive - 1, 0)); }
    else if (e.key === 'Escape') hideSugg();
    else if (e.key === 'Enter') {
      e.preventDefault(); clearTimeout(timer);
      if (suggActive >= 0 && suggRes[suggActive]) return selectProd(suggRes[suggActive].pos);
      lookupTyped();
    }
  });
  $('sugerencias').addEventListener('click', function (e) { var d = e.target.closest('.sug'); if (d && suggRes[+d.dataset.i]) selectProd(suggRes[+d.dataset.i].pos); });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search-box')) hideSugg(); });

  /** Enter: código exacto único → lo abre; un solo resultado → lo abre; varios → pide elegir (nunca adivina). */
  function lookupTyped() {
    var q = $('buscador').value.trim(); if (!q || !index) return;
    var byCode = OFSearch.findByCode(index, q);
    if (byCode.length === 1) return selectProd(byCode[0]);
    var res = OFSearch.search(index, q, 40);
    if (res.length === 1) return selectProd(res[0].pos);
    runSearch();
    toast(res.length ? 'Hay varios productos parecidos: toca el correcto.' : 'No se encontró “' + q + '”.', !res.length);
  }

  function selectProd(pos) {
    if (!turno) return;
    var p = catalog[pos]; if (!p) return;
    prod = p; hideSugg(); $('buscador').value = '';
    $('estadoBusqueda').textContent = '';
    $('pNombre').textContent = p.descripcion; $('pCodigo').textContent = 'Código: ' + p.codigo; $('pSal').textContent = p.sal ? '📍 Ubicación: ' + p.sal : '';
    $('pNormal').textContent = F(FCalc.toCents(p.precio)); $('pDesc').textContent = F(FCalc.toCents(p.descuento));
    $('pAplica').textContent = F(precioAplica(p)); $('pAplicaLbl').textContent = 'Se cobra (' + (hoyMod() === 'descuento' ? 'desc. 25%' : 'normal') + ')';
    $('pCant').value = 1; calcProd(); $('productoPanel').hidden = false;
    $('productoPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('pCant').select && $('pCant').select();
  }
  function calcProd() {
    if (!prod) return;
    var q = FCalc.clampQty($('pCant').value);
    $('pImporte').textContent = F(q * precioAplica(prod));
  }
  $('pCant').addEventListener('input', calcProd);
  $('pCant').addEventListener('change', function () { $('pCant').value = FCalc.clampQty($('pCant').value); calcProd(); });
  $('pCant').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addProd(); } });
  $('pMenos').addEventListener('click', function () { $('pCant').value = FCalc.clampQty(FCalc.clampQty($('pCant').value) - 1); calcProd(); });
  $('pMas').addEventListener('click', function () { $('pCant').value = FCalc.clampQty(FCalc.clampQty($('pCant').value) + 1); calcProd(); });
  $('btnAgregar').addEventListener('click', addProd);

  function addProd() {
    if (!prod || !turno) return;
    var q = FCalc.clampQty($('pCant').value);
    var ex = cart.filter(function (x) { return x.codigo === prod.codigo; })[0];
    if (ex) ex.cantidad = Math.min(999, ex.cantidad + q);
    else cart.push({ codigo: prod.codigo, nombre: prod.descripcion, cantidad: q, precioCents: FCalc.toCents(prod.precio), descuentoCents: FCalc.toCents(prod.descuento) });
    prod = null; $('productoPanel').hidden = true; saveDraft(); renderCart(); toast('Producto agregado ✓');
    if (desktop()) $('buscador').focus();
  }

  /* ───────── Carrito ───────── */
  function saveDraft() { return turno ? FDB.setMeta('borrador', { turnoId: turno.id, cart: cart }).catch(function () {}) : Promise.resolve(); }
  function totals() { return FCalc.calcCart(cart, saleMod || hoyMod()); }

  function renderCart() {
    var t = totals();
    $('cartRows').innerHTML = cart.length ? t.lines.map(function (l, i) {
      return '<div class="crow"><div><div class="cn">' + esc(l.nombre) + '</div><div class="cc">' + esc(l.codigo) + ' · ' + F(l.precioUnitCents) + ' c/u</div></div>' +
        '<button class="cdel" data-del="' + i + '" aria-label="Quitar">✕</button>' +
        '<div class="cq"><button data-dec="' + i + '" aria-label="Menos">−</button><span>' + l.cantidad + '</span><button data-inc="' + i + '" aria-label="Más">+</button></div>' +
        '<div class="cp">Importe<b>' + F(l.importeCents) + '</b></div></div>';
    }).join('') : '<div class="empty">Agrega productos para comenzar</div>';
    $('badgeCount').textContent = cart.length;
    $('lblSubtotal').textContent = F(t.subtotalCents); $('lblDescuento').textContent = '-' + F(t.descuentoCents); $('lblTotal').textContent = F(t.totalCents);
    $('btnCobrar').disabled = !cart.length;
  }
  $('cartRows').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.del != null) cart.splice(+b.dataset.del, 1);
    else if (b.dataset.inc != null) cart[+b.dataset.inc].cantidad = Math.min(999, cart[+b.dataset.inc].cantidad + 1);
    else if (b.dataset.dec != null) { var it = cart[+b.dataset.dec]; if (it.cantidad > 1) it.cantidad--; else cart.splice(+b.dataset.dec, 1); }
    saveDraft(); renderCart();
  });
  $('btnLimpiar').addEventListener('click', function () {
    if (!cart.length) return;
    if (!confirm('¿Limpiar la venta actual?')) return;
    cart = []; saveDraft(); renderCart();
  });

  /* ───────── Cobro ───────── */
  var quickVals = [50, 100, 200, 500];
  function openCobro() {
    if (!cart.length || !turno) return;
    var t = totals(); if (t.totalCents <= 0) return toast('El total debe ser mayor a $0.00', true);
    saleMod = hoyMod(); saleId = FDB.uuid(); saving = false;   // el precio queda fijo durante el cobro       // un id por intento de cobro: si se repite, no duplica
    $('cTotal').textContent = F(t.totalCents); $('cRecibido').value = ''; showErr('cError', '');
    $('cQuick').innerHTML = '<button type="button" data-exact="1">Exacto</button>' + quickVals.map(function (v) { return '<button type="button" data-q="' + v + '">$' + v + '</button>'; }).join('');
    $('cobroForm').hidden = false; $('cobroOk').hidden = true; updCobro(); openModal('modalCobro');
    setTimeout(function () { $('cRecibido').focus(); }, 50);
  }
  function updCobro() {
    var t = totals(), rec = FCalc.parseMoney($('cRecibido').value), c = FCalc.calcCobro(t.totalCents, rec);
    var box = $('cCambioBox');
    if (rec === null) { box.className = 'cambio neutral'; $('cCambioLbl').textContent = 'Cambio'; $('cCambio').textContent = '—'; }
    else if (!c.ok) { box.className = 'cambio bad'; $('cCambioLbl').textContent = 'Faltan'; $('cCambio').textContent = F(c.faltaCents); }
    else { box.className = 'cambio'; $('cCambioLbl').textContent = 'Cambio'; $('cCambio').textContent = F(c.cambioCents); }
    $('btnConfirmar').disabled = !c.ok || saving;
  }
  $('cRecibido').addEventListener('input', updCobro);
  $('cRecibido').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!$('btnConfirmar').disabled) confirmarPago(); } });
  $('cQuick').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var t = totals(); $('cRecibido').value = b.dataset.exact ? (t.totalCents / 100).toFixed(2) : b.dataset.q; updCobro();
  });
  $('btnCobrar').addEventListener('click', openCobro);
  $('btnVolver').addEventListener('click', function () { closeModal('modalCobro'); saleMod = null; renderCart(); });
  $('btnConfirmar').addEventListener('click', confirmarPago);

  function confirmarPago() {
    if (saving || !turno || !cart.length) return;
    var t = totals(), rec = FCalc.parseMoney($('cRecibido').value), c = FCalc.calcCobro(t.totalCents, rec);
    if (!c.ok) return;
    saving = true; $('btnConfirmar').disabled = true; $('btnConfirmar').textContent = '⏳ Guardando…'; showErr('cError', '');
    var venta = { id: saleId, turnoId: turno.id, vendedor: turno.vendedor, sucursal: turno.sucursal, modalidad: saleMod || hoyMod(), fecha: new Date().toISOString(),
      items: t.lines, subtotalCents: t.subtotalCents, descuentoCents: t.descuentoCents, totalCents: t.totalCents, recibidoCents: rec, cambioCents: c.cambioCents };
    FDB.addVenta(venta).then(function (r) {
      // Solo aquí (escritura confirmada por IndexedDB) se considera registrada.
      var v = r.venta; cart = []; saveDraft(); renderCart(); refreshSide();
      $('okCambio').textContent = F(v.cambioCents);
      $('okInfo').textContent = 'Folio ' + v.folio + ' · Total ' + F(v.totalCents) + ' · Recibido ' + F(v.recibidoCents) + '. Guardada en este dispositivo.';
      $('cobroForm').hidden = true; $('cobroOk').hidden = false; saleId = null; saleMod = null; saving = false;
    }).catch(function () {
      saving = false; $('btnConfirmar').textContent = '✅ Confirmar pago'; updCobro();
      showErr('cError', 'No se pudo guardar la venta en este dispositivo. La venta NO se registró. Intenta de nuevo.');
    }).then(function () { $('btnConfirmar').textContent = '✅ Confirmar pago'; });
  }
  $('btnNueva').addEventListener('click', function () { closeModal('modalCobro'); saleMod = null; renderCart(); if (desktop()) $('buscador').focus(); });

  /* ───────── Resumen, historial, sincronización ───────── */
  function refreshSide() {
    if (!turno) { return Promise.resolve(); }
    return Promise.all([FDB.ventasDeTurno(turno.id), FDB.countPendientes()]).then(function (r) {
      var ventas = r[0], pend = r[1], c = FCalc.calcCorte(turno.fondoCents, ventas, null);
      $('rNum').textContent = c.numVentas; $('rTotal').textContent = F(c.totalCents); $('rDesc').textContent = F(c.descuentoCents);
      var last = ventas.slice(-15).reverse();
      $('historial').innerHTML = last.length ? last.map(function (v, i) {
        return '<details class="hv"><summary><span>' + esc(v.folio) + ' · ' + hora(v.fecha) + '</span><b>' + F(v.totalCents) + '</b></summary><div class="items">' +
          v.items.map(function (it) { return '<div><span>' + esc(it.nombre.slice(0, 38)) + ' ×' + it.cantidad + '</span><span>' + F(it.importeCents) + '</span></div>'; }).join('') +
          '<div><span>Recibido ' + F(v.recibidoCents) + '</span><span>Cambio ' + F(v.cambioCents) + '</span></div></div></details>';
      }).join('') + (ventas.length > 15 ? '<div class="empty small">Mostrando las últimas 15 de ' + ventas.length + '</div>' : '') : '<div class="empty small">Sin ventas aún</div>';
      $('syncMsg').textContent = 'Las ventas se guardan en ESTE dispositivo. ' + pend + (pend === 1 ? ' venta pendiente' : ' ventas pendientes') +
        ' de enviar al servidor (aún no conectado). No borres los datos del navegador de este teléfono.';
    });
  }
  function updNet() { var o = navigator.onLine; var c = $('chipRed'); c.textContent = o ? 'En línea' : 'Sin conexión'; c.className = 'chip ' + (o ? 'chip-ok' : 'chip-off'); }
  window.addEventListener('online', updNet); window.addEventListener('offline', updNet); updNet();

  /* ───────── ¿Dónde va ordenado? ─────────
     El catálogo está en el mismo orden del estante (por la columna Sal). Se muestra la letra de la Sal
     del producto buscado y los 5 productos antes y 5 después, con su descripción, para guiarse. */
  var VECINOS = 5;
  function letraDe(sal) { var c = OFSearch.normalize(sal).charAt(0).toUpperCase(); return c || '?'; }
  function dondeMostrar(pos) {
    var p = catalog[pos]; if (!p) return;
    var ini = Math.max(0, pos - VECINOS), fin = Math.min(catalog.length - 1, pos + VECINOS);
    $('dOpciones').hidden = true; $('dOpciones').innerHTML = ''; $('dMsg').textContent = '';
    $('dLetra').textContent = letraDe(p.sal); $('dSal').textContent = p.sal || '—';
    var html = '';
    for (var i = ini; i <= fin; i++) {
      var x = catalog[i];
      html += '<div class="nb' + (i === pos ? ' me' : '') + '" data-pos="' + i + '"><b>' + esc(x.descripcion) + (i === pos ? ' ◀ buscado' : '') + '</b><small>📍 ' + esc(x.sal) + ' · ' + esc(x.codigo) + '</small></div>';
    }
    $('dLista').innerHTML = html; $('dResultado').hidden = false;
    var me = $('dLista').querySelector('.me'); if (me && me.scrollIntoView) me.scrollIntoView({ block: 'center' });
  }
  function dondeBuscar() {
    var q = $('dTexto').value.trim(); $('dResultado').hidden = true;
    if (!q || !index) { $('dOpciones').hidden = true; $('dMsg').textContent = ''; return; }
    var byCode = OFSearch.findByCode(index, q);
    if (byCode.length === 1) return dondeMostrar(byCode[0]);
    var res = OFSearch.search(index, q, 12);
    if (!res.length) { $('dOpciones').hidden = true; $('dMsg').textContent = 'No se encontró “' + q + '”.'; return; }
    if (res.length === 1) return dondeMostrar(res[0].pos);
    $('dMsg').textContent = res.total + ' resultados' + (res.total > res.length ? ' (mostrando ' + res.length + ')' : '') + ': toca el que buscas.';
    $('dOpciones').innerHTML = res.map(function (r) { return '<div class="sug" data-pos="' + r.pos + '"><b>' + esc(r.item.descripcion) + '</b><small class="sal">📍 ' + esc(r.item.sal) + '</small></div>'; }).join('');
    $('dOpciones').hidden = false;
  }
  function dondeCerrarCamara() { OFScanner.stop(); $('dScannerBox').hidden = true; }
  function dondeAbrir() {
    $('dTexto').value = ''; $('dMsg').textContent = ''; $('dOpciones').hidden = true; $('dResultado').hidden = true;
    openModal('modalDonde'); setTimeout(function () { $('dTexto').focus(); }, 50);
  }
  $('btnDonde').addEventListener('click', dondeAbrir);
  $('dTexto').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(dondeBuscar, 120); });
  $('dTexto').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); dondeBuscar(); } });
  $('dOpciones').addEventListener('click', function (e) { var d = e.target.closest('[data-pos]'); if (d) dondeMostrar(+d.dataset.pos); });
  $('dLista').addEventListener('click', function (e) { var d = e.target.closest('[data-pos]'); if (d) dondeMostrar(+d.dataset.pos); });   // tocar un vecino lo centra
  $('dScan').addEventListener('click', function () {
    if ($('dScannerBox').hidden) {
      $('dScannerBox').hidden = false; $('dScanMsg').className = 'muted small'; $('dScanMsg').textContent = 'Iniciando cámara… acepta el permiso si lo pide.';
      OFScanner.start($('dVideo'), function (code) {
        dondeCerrarCamara(); $('dTexto').value = code;
        var f = OFSearch.findByCode(index, code);
        if (f.length === 1) dondeMostrar(f[0]); else if (f.length > 1) dondeBuscar(); else { $('dResultado').hidden = true; $('dMsg').textContent = 'Código no encontrado: ' + code; }
      }, function (m) { $('dScanMsg').className = 'err small'; $('dScanMsg').textContent = m; });
      $('dVideo').addEventListener('playing', function once() { $('dVideo').removeEventListener('playing', once); $('dScanMsg').textContent = 'Apunta la cámara al código de barras.'; });
    } else dondeCerrarCamara();
  });
  $('dScanClose').addEventListener('click', dondeCerrarCamara);
  $('dCerrar').addEventListener('click', function () { dondeCerrarCamara(); closeModal('modalDonde'); });

  /* ───────── Reporte de ventas (solo en pantalla, no descarga nada) ───────── */
  function ymd(d) { var m = d.getMonth() + 1, dd = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd; }
  function renderReporte() {
    var dia = $('repFecha').value || ymd(new Date());
    FDB.allVentas().then(function (todas) {
      var ventas = todas.filter(function (v) { return ymd(new Date(v.fecha)) === dia; })
        .sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; });
      var c = FCalc.calcCorte(0, ventas, null);
      $('repNum').textContent = c.numVentas; $('repTotal').textContent = F(c.totalCents); $('repDesc').textContent = F(c.descuentoCents);
      $('repLista').innerHTML = ventas.length ? ventas.map(function (v) {
        return '<details class="hv"><summary><span>' + esc(v.folio) + ' · ' + hora(v.fecha) + ' · ' + esc(v.vendedor) + (v.modalidad === 'descuento' ? ' · 25%' : '') + '</span><b>' + F(v.totalCents) + '</b></summary><div class="items">' +
          v.items.map(function (it) { return '<div><span>' + esc(it.nombre.slice(0, 38)) + ' ×' + it.cantidad + '</span><span>' + F(it.importeCents) + '</span></div>'; }).join('') +
          '<div><span>Recibido ' + F(v.recibidoCents) + '</span><span>Cambio ' + F(v.cambioCents) + '</span></div></div></details>';
      }).join('') : '<div class="empty small">No hay ventas en este día</div>';
    }).catch(function () { $('repLista').innerHTML = '<div class="empty small">No se pudo leer el almacenamiento de este dispositivo.</div>'; });
  }
  function abrirReporte(dia) { $('repFecha').value = dia || ymd(new Date()); renderReporte(); openModal('modalReporte'); }
  $('btnReporte').addEventListener('click', function () { abrirReporte(); });
  $('repFecha').addEventListener('change', renderReporte);
  $('btnRepCerrar').addEventListener('click', function () { closeModal('modalReporte'); });

  /* ───────── Cierre de turno / corte ───────── */
  function kvRows(c, extra) {
    return [['Fondo inicial', F(c.fondoCents)], ['Ventas realizadas', c.numVentas], ['Total vendido', F(c.totalCents)], ['Descuentos otorgados', F(c.descuentoCents)],
      ['Efectivo recibido', F(c.recibidoCents)], ['Cambio entregado', F(c.cambioCents)], ['Efectivo esperado en caja', F(c.esperadoCents)]].concat(extra || [])
      .map(function (r) { return '<dt' + (r[2] ? ' class="sep"' : '') + '>' + r[0] + '</dt><dd' + (r[2] ? ' class="sep"' : '') + '>' + esc(r[1]) + '</dd>'; }).join('');
  }
  var cierreCalc = null;
  $('btnCierre').addEventListener('click', function () {
    if (!turno) return;
    if (cart.length) return toast('Termina o limpia la venta actual antes de cerrar el turno', true);
    FDB.ventasDeTurno(turno.id).then(function (ventas) {
      cierreCalc = { ventas: ventas };
      var c = FCalc.calcCorte(turno.fondoCents, ventas, null);
      $('cierreResumen').innerHTML = kvRows(c);
      $('cContado').value = ''; $('cQuien').value = turno.vendedor; showErr('ciError', ''); updCierre();
      $('cierreForm').hidden = false; $('cierreOk').hidden = true; openModal('modalCierre'); setTimeout(function () { $('cContado').focus(); }, 50);
    });
  });
  function updCierre() {
    var contado = FCalc.parseMoney($('cContado').value), box = $('cDifBox');
    var c = FCalc.calcCorte(turno.fondoCents, cierreCalc ? cierreCalc.ventas : [], contado);
    if (contado === null) { box.className = 'cambio neutral'; $('cDifLbl').textContent = 'Diferencia'; $('cDif').textContent = '—'; }
    else if (c.diferenciaCents === 0) { box.className = 'cambio'; $('cDifLbl').textContent = 'Caja cuadrada'; $('cDif').textContent = '$0.00'; }
    else { box.className = 'cambio bad'; $('cDifLbl').textContent = c.diferenciaCents > 0 ? 'Sobrante' : 'Faltante'; $('cDif').textContent = F(Math.abs(c.diferenciaCents)); }
    $('btnCierreOk').disabled = contado === null || !$('cQuien').value.trim();
  }
  $('cContado').addEventListener('input', updCierre); $('cQuien').addEventListener('input', updCierre);
  $('btnCierreVolver').addEventListener('click', function () { closeModal('modalCierre'); });
  $('btnCierreOk').addEventListener('click', function () {
    if (!turno || closing) return;
    var contado = FCalc.parseMoney($('cContado').value), quien = $('cQuien').value.trim(); if (contado === null || !quien) return;
    closing = true; $('btnCierreOk').disabled = true;
    FDB.ventasDeTurno(turno.id).then(function (ventas) {         // se recalcula con lo realmente guardado
      var c = FCalc.calcCorte(turno.fondoCents, ventas, contado);
      var t = Object.assign({}, turno, { estado: 'cerrado', horaSalida: new Date().toISOString(), cierre: Object.assign({}, c, { realizadoPor: quien }), sync: 'pendiente' });
      return FDB.putTurno(t).then(function () { return FDB.delMeta('turnoActivoId'); }).then(function () { return FDB.delMeta('borrador'); }).then(function () { return { t: t, c: c }; });
    }).then(function (r) {
      lastCierre = r.t; turno = null; cart = []; prod = null;
      $('cierreFinal').innerHTML = kvRows(r.c, [['Efectivo contado', F(r.c.contadoCents)], ['Diferencia', (r.c.diferenciaCents > 0 ? 'Sobrante ' : r.c.diferenciaCents < 0 ? 'Faltante ' : 'Cuadrada ') + (r.c.diferenciaCents ? F(Math.abs(r.c.diferenciaCents)) : '$0.00'), 1], ['Corte realizado por', quien], ['Hora de salida', fechaHora(r.t.horaSalida)]]);
      $('cierreForm').hidden = true; $('cierreOk').hidden = false; closing = false; renderAll();
    }).catch(function () { closing = false; $('btnCierreOk').disabled = false; showErr('ciError', 'No se pudo guardar el cierre. El turno sigue abierto. Intenta de nuevo.'); });
  });
  $('btnReporteTurno').addEventListener('click', function () { if (!lastCierre) return; closeModal('modalCierre'); abrirReporte(ymd(new Date(lastCierre.horaEntrada))); });
  $('btnNuevoTurno').addEventListener('click', function () { closeModal('modalCierre'); showTurnoModal(); });

  /* ───────── Escáner ───────── */
  function openScanner() {
    if (!turno) return;
    $('scannerBox').hidden = false; $('scanMsg').className = 'muted small'; $('scanMsg').textContent = 'Iniciando cámara… acepta el permiso si lo pide.';
    OFScanner.start($('video'), function (code) { closeScanner(); lookupCode(code); }, function (m) { $('scanMsg').className = 'err small'; $('scanMsg').textContent = m; });
    $('video').addEventListener('playing', function once() { $('video').removeEventListener('playing', once); $('scanMsg').textContent = 'Apunta la cámara al código de barras.'; });
  }
  function closeScanner() { OFScanner.stop(); $('scannerBox').hidden = true; }
  $('btnScan').addEventListener('click', function () { $('scannerBox').hidden ? openScanner() : closeScanner(); });
  $('btnScanClose').addEventListener('click', closeScanner);

  function lookupCode(code) {
    var f = OFSearch.findByCode(index, code);
    if (f.length === 1) return selectProd(f[0]);
    if (f.length > 1) { $('buscador').value = code; runSearch(); return toast('Ese código está en varios productos: elige uno.'); }
    toast('Código no encontrado: ' + code, true);
  }

  /* Si cambia el día con la app abierta (por ejemplo pasa de miércoles a jueves), se actualizan los precios. */
  function vigilaDia() {
    if (modoVisto === null || hoyMod() === modoVisto) return;
    renderTurno(); renderCart();
    if (prod) { $('pAplica').textContent = F(precioAplica(prod)); $('pAplicaLbl').textContent = 'Se cobra (' + (hoyMod() === 'descuento' ? 'desc. 25%' : 'normal') + ')'; calcProd(); }
    toast('Hoy: ' + hoyTexto());
  }
  setInterval(vigilaDia, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) vigilaDia(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  /* ───────── Arranque ───────── */
  function renderAll() {
    renderTurno(); renderCart(); refreshSide();
    $('productoPanel').hidden = !prod;
    if (!turno) { $('historial').innerHTML = '<div class="empty small">Sin turno abierto</div>'; $('rNum').textContent = '0'; $('rTotal').textContent = '$0.00'; $('rDesc').textContent = '$0.00'; }
  }

  function init() {
    loadCatalog().catch(function () { $('estadoBusqueda').textContent = ''; toast('No se pudo cargar el catálogo. Conéctate a internet y recarga.', true); })
      .then(function () { return FDB.getMeta('turnoActivoId'); })
      .then(function (id) { return id ? FDB.getTurno(id) : null; })
      .then(function (t) {
        if (t && t.estado === 'abierto') {
          turno = t;
          return FDB.getMeta('borrador').then(function (b) { if (b && b.turnoId === t.id && Array.isArray(b.cart)) cart = b.cart; });
        }
      })
      .then(function () { renderAll(); if (!turno) showTurnoModal(); })
      .catch(function () { toast('No se pudo abrir el almacenamiento local de este navegador.', true); });
  }
  init();

  /* ───────── Service worker y actualizaciones ───────── */
  if ('serviceWorker' in navigator) {
    var reloading = false, had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('venta-sw.js').then(function (reg) {
      function ask(w) { $('updateBanner').hidden = false; $('updateBtn').onclick = function () { w.postMessage({ type: 'SKIP_WAITING' }); }; }
      if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
      reg.addEventListener('updatefound', function () { var w = reg.installing; if (w) w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); }); });
      reg.update().catch(function () {});
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (reloading || !had) return; reloading = true; location.reload(); });
  }
})();
