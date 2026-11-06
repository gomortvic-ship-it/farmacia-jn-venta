/* venta.js — Farmacia JN · Punto de venta (Etapa 1: venta, turnos, cobro, corte, sin internet).
   Todo se guarda en IndexedDB de este dispositivo. El servidor (Supabase) llega en la Etapa 2. */
(function () {
  'use strict';
  var SUCURSAL = 'Principal';
  var $ = function (id) { return document.getElementById(id); };
  var F = FCalc.fmt;

  var catalog = [], index = null, turno = null, cart = [], prod = null;
  var suggRes = [], suggActive = -1, timer = null, saving = false, closing = false, saleId = null, lastCierre = null;

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
      // data.json real: CODIGO, PRODUCTO, PRECIO, DESCUENTO (no se modifica; solo se lee)
      catalog = res.d.map(function (x) { return { codigo: String(x.CODIGO), descripcion: String(x.PRODUCTO), sal: '', precio: Number(x.PRECIO), descuento: Number(x.DESCUENTO) }; });
      index = OFSearch.buildIndex(catalog);
      $('cacheBanner').hidden = !res.fromCache;
      $('estadoBusqueda').textContent = catalog.length.toLocaleString('es-MX') + ' productos en el catálogo.';
    });
  }

  /* ───────── Turno ───────── */
  function modLabel(m) { return m === 'descuento' ? 'Descuento 25%' : 'Precio normal'; }

  function renderTurno() {
    var t = turno;
    $('hdrVendedor').textContent = t ? t.vendedor : '—';
    $('tVendedor').textContent = t ? t.vendedor : '—';
    $('tSucursal').textContent = t ? t.sucursal : '—';
    $('tEntrada').textContent = t ? fechaHora(t.horaEntrada) : '—';
    $('tFondo').textContent = t ? F(t.fondoCents) : '—';
    var p = $('tModalidad'); p.textContent = t ? modLabel(t.modalidad) : '—'; p.className = 'pill' + (t && t.modalidad === 'descuento' ? ' desc' : '');
    $('buscador').disabled = !t; $('btnScan').disabled = !t;
  }

  function showTurnoModal() {
    $('mtSucursal').textContent = SUCURSAL; showErr('mtError', '');
    FDB.getMeta('nombres').then(function (n) {
      $('listaNombres').innerHTML = (n || []).map(function (x) { return '<option value="' + esc(x) + '">'; }).join('');
    });
    $('mtFondo').value = ''; openModal('modalTurno'); setTimeout(function () { $('mtNombre').focus(); }, 50);
  }

  $('formTurno').addEventListener('submit', function (e) {
    e.preventDefault();
    var nombre = $('mtNombre').value.replace(/\s+/g, ' ').trim();
    var fondo = FCalc.parseMoney($('mtFondo').value);
    var mod = document.querySelector('input[name=modalidad]:checked').value;
    if (!nombre) return showErr('mtError', 'Escribe tu nombre.');
    if (fondo === null) return showErr('mtError', 'Escribe el fondo inicial de caja (por ejemplo 500 o 500.00). Es obligatorio.');
    var t = { id: FDB.uuid(), sucursal: SUCURSAL, vendedor: nombre, fecha: new Date().toISOString().slice(0, 10), horaEntrada: new Date().toISOString(),
      fondoCents: fondo, modalidad: mod, dispositivo: (navigator.userAgent || '').slice(0, 120), estado: 'abierto', sync: 'pendiente' };
    FDB.putTurno(t).then(function () { return FDB.setMeta('turnoActivoId', t.id); })
      .then(function () { return FDB.getMeta('nombres'); })
      .then(function (n) { n = n || []; if (n.indexOf(nombre) === -1) n.push(nombre); return FDB.setMeta('nombres', n.slice(-30)); })
      .then(function () { turno = t; cart = []; prod = null; closeModal('modalTurno'); renderAll(); toast('Turno iniciado · ' + modLabel(mod)); })
      .catch(function () { showErr('mtError', 'No se pudo guardar el turno en este dispositivo. No se inició.'); });
  });

  /* ───────── Búsqueda ───────── */
  function precioAplica(p) { return FCalc.unitCents(p, turno ? turno.modalidad : 'normal'); }

  function onInput() {
    clearTimeout(timer); timer = setTimeout(runSearch, 60);
  }
  function runSearch() {
    var q = $('buscador').value.trim();
    if (!index) return;
    if (!q) { hideSugg(); $('estadoBusqueda').textContent = catalog.length.toLocaleString('es-MX') + ' productos en el catálogo.'; return; }
    suggRes = OFSearch.search(index, q, 8); suggActive = -1;
    if (!suggRes.length) { hideSugg(); $('estadoBusqueda').textContent = 'Sin resultados para “' + q + '”.'; return; }
    $('estadoBusqueda').textContent = suggRes.total + (suggRes.total === 1 ? ' resultado' : ' resultados') + (suggRes.total > suggRes.length ? ' (mostrando ' + suggRes.length + ')' : '');
    $('sugerencias').innerHTML = suggRes.map(function (r, i) {
      return '<div class="sug" role="option" data-i="' + i + '"><b>' + esc(r.item.descripcion) + '</b><small>' + esc(r.item.codigo) + ' · <span class="p">' + F(precioAplica(r.item)) + '</span></small></div>';
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
    var res = OFSearch.search(index, q, 8);
    if (res.length === 1) return selectProd(res[0].pos);
    runSearch();
    toast(res.length ? 'Hay varios productos parecidos: toca el correcto.' : 'No se encontró “' + q + '”.', !res.length);
  }

  function selectProd(pos) {
    if (!turno) return;
    var p = catalog[pos]; if (!p) return;
    prod = p; hideSugg(); $('buscador').value = '';
    $('estadoBusqueda').textContent = '';
    $('pNombre').textContent = p.descripcion; $('pCodigo').textContent = 'Código: ' + p.codigo;
    $('pNormal').textContent = F(FCalc.toCents(p.precio)); $('pDesc').textContent = F(FCalc.toCents(p.descuento));
    $('pAplica').textContent = F(precioAplica(p)); $('pAplicaLbl').textContent = 'Se cobra (' + (turno.modalidad === 'descuento' ? 'desc. 25%' : 'normal') + ')';
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
  function totals() { return FCalc.calcCart(cart, turno ? turno.modalidad : 'normal'); }

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
    saleId = FDB.uuid(); saving = false;       // un id por intento de cobro: si se repite, no duplica
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
  $('btnVolver').addEventListener('click', function () { closeModal('modalCobro'); });
  $('btnConfirmar').addEventListener('click', confirmarPago);

  function confirmarPago() {
    if (saving || !turno || !cart.length) return;
    var t = totals(), rec = FCalc.parseMoney($('cRecibido').value), c = FCalc.calcCobro(t.totalCents, rec);
    if (!c.ok) return;
    saving = true; $('btnConfirmar').disabled = true; $('btnConfirmar').textContent = '⏳ Guardando…'; showErr('cError', '');
    var venta = { id: saleId, turnoId: turno.id, vendedor: turno.vendedor, sucursal: turno.sucursal, modalidad: turno.modalidad, fecha: new Date().toISOString(),
      items: t.lines, subtotalCents: t.subtotalCents, descuentoCents: t.descuentoCents, totalCents: t.totalCents, recibidoCents: rec, cambioCents: c.cambioCents };
    FDB.addVenta(venta).then(function (r) {
      // Solo aquí (escritura confirmada por IndexedDB) se considera registrada.
      var v = r.venta; cart = []; saveDraft(); renderCart(); refreshSide();
      $('okCambio').textContent = F(v.cambioCents);
      $('okInfo').textContent = 'Folio ' + v.folio + ' · Total ' + F(v.totalCents) + ' · Recibido ' + F(v.recibidoCents) + '. Guardada en este dispositivo.';
      $('cobroForm').hidden = true; $('cobroOk').hidden = false; saleId = null; saving = false;
    }).catch(function () {
      saving = false; $('btnConfirmar').textContent = '✅ Confirmar pago'; updCobro();
      showErr('cError', 'No se pudo guardar la venta en este dispositivo. La venta NO se registró. Intenta de nuevo.');
    }).then(function () { $('btnConfirmar').textContent = '✅ Confirmar pago'; });
  }
  $('btnNueva').addEventListener('click', function () { closeModal('modalCobro'); if (desktop()) $('buscador').focus(); });

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
        ' de enviar al servidor (aún no conectado: Etapa 2). No borres los datos del navegador; descarga el CSV como respaldo.';
    });
  }
  function updNet() { var o = navigator.onLine; var c = $('chipRed'); c.textContent = o ? 'En línea' : 'Sin conexión'; c.className = 'chip ' + (o ? 'chip-ok' : 'chip-off'); }
  window.addEventListener('online', updNet); window.addEventListener('offline', updNet); updNet();

  /* ───────── CSV ───────── */
  function csvCell(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function pesos(c) { return (c / 100).toFixed(2); }
  function buildCsv(ventas) {
    var head = ['Folio', 'Fecha', 'Hora', 'Turno', 'Vendedora', 'Sucursal', 'Modalidad', 'Código', 'Producto', 'Cantidad', 'Precio unitario', 'Importe', 'Subtotal venta', 'Descuento venta', 'Total venta', 'Recibido', 'Cambio', 'Sincronización', 'ID venta'];
    var rows = [head];
    ventas.forEach(function (v) {
      var d = new Date(v.fecha);
      v.items.forEach(function (it) {
        rows.push([v.folio, d.toLocaleDateString('es-MX'), d.toLocaleTimeString('es-MX'), v.turnoId, v.vendedor, v.sucursal, modLabel(v.modalidad), it.codigo, it.nombre, it.cantidad,
          pesos(it.precioUnitCents), pesos(it.importeCents), pesos(v.subtotalCents), pesos(v.descuentoCents), pesos(v.totalCents), pesos(v.recibidoCents), pesos(v.cambioCents), v.sync, v.id]);
      });
    });
    return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }
  function download(name, text) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }
  $('btnCsv').addEventListener('click', function () {
    FDB.allVentas().then(function (v) {
      if (!v.length) return toast('Aún no hay ventas guardadas', true);
      v.sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
      download('ventas-farmacia-jn-' + new Date().toISOString().slice(0, 10) + '.csv', buildCsv(v));
    });
  });

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
      $('cierreResumen').innerHTML = kvRows(c, [['Modalidad', modLabel(turno.modalidad)]]);
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
  $('btnCsvTurno').addEventListener('click', function () {
    if (!lastCierre) return;
    FDB.ventasDeTurno(lastCierre.id).then(function (v) { if (!v.length) return toast('Ese turno no tuvo ventas', true); download('turno-' + lastCierre.fecha + '-' + lastCierre.vendedor.replace(/\W+/g, '_') + '.csv', buildCsv(v)); });
  });
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
