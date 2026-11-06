/* calc.js — cálculos de venta, cobro y corte. Todo en CENTAVOS (enteros) para evitar errores de decimales. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toCents(pesos) { return Math.round(Number(pesos) * 100); }

  /** "$1,200.50" | "200" | "200.5" → centavos; null si no es válido. */
  function parseMoney(text) {
    var s = String(text == null ? '' : text).replace(/[$\s,]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  function fmt(cents) {
    var neg = cents < 0, v = Math.abs(cents);
    var s = '$' + Math.floor(v / 100).toLocaleString('en-US') + '.' + ('0' + (v % 100)).slice(-2);
    return neg ? '-' + s : s;
  }

  /** Precio unitario según la modalidad del turno ('normal' | 'descuento'), en centavos. */
  function unitCents(prod, modalidad) {
    return toCents(modalidad === 'descuento' ? prod.descuento : prod.precio);
  }

  function clampQty(q) {
    q = parseInt(q, 10);
    if (!isFinite(q) || q < 1) return 1;
    return Math.min(q, 999);
  }

  /**
   * Totales de una venta. items: [{codigo, nombre, cantidad, precioCents, descuentoCents}]
   * (precio normal y precio con descuento del catálogo, sin recalcular el 25%).
   */
  function calcCart(items, modalidad) {
    var subtotal = 0, total = 0;
    var lines = items.map(function (it) {
      var normal = it.precioCents, unit = modalidad === 'descuento' ? it.descuentoCents : it.precioCents;
      subtotal += it.cantidad * normal; total += it.cantidad * unit;
      return { codigo: it.codigo, nombre: it.nombre, cantidad: it.cantidad,
        precioNormalCents: normal, precioUnitCents: unit, importeCents: it.cantidad * unit };
    });
    return { lines: lines, subtotalCents: subtotal, totalCents: total, descuentoCents: subtotal - total };
  }

  function calcCobro(totalCents, recibidoCents) {
    if (recibidoCents == null || totalCents <= 0) return { ok: false, cambioCents: 0, faltaCents: Math.max(totalCents, 0) };
    var d = recibidoCents - totalCents;
    return { ok: d >= 0, cambioCents: Math.max(d, 0), faltaCents: Math.max(-d, 0) };
  }

  /**
   * Corte de un turno. ventas: ventas del turno (con totalCents, descuentoCents, recibidoCents, cambioCents).
   * Efectivo esperado = fondo inicial + efectivo recibido − cambio entregado (− salidas autorizadas, aún no implementadas).
   */
  function calcCorte(fondoCents, ventas, contadoCents) {
    var r = { numVentas: ventas.length, totalCents: 0, subtotalCents: 0, descuentoCents: 0, recibidoCents: 0, cambioCents: 0 };
    ventas.forEach(function (v) {
      r.totalCents += v.totalCents; r.subtotalCents += v.subtotalCents; r.descuentoCents += v.descuentoCents;
      r.recibidoCents += v.recibidoCents; r.cambioCents += v.cambioCents;
    });
    r.fondoCents = fondoCents;
    r.salidasCents = 0;
    r.esperadoCents = fondoCents + r.recibidoCents - r.cambioCents - r.salidasCents;
    r.contadoCents = contadoCents == null ? null : contadoCents;
    r.diferenciaCents = contadoCents == null ? null : contadoCents - r.esperadoCents;
    return r;
  }

  return { toCents: toCents, parseMoney: parseMoney, fmt: fmt, unitCents: unitCents, clampQty: clampQty,
    calcCart: calcCart, calcCobro: calcCobro, calcCorte: calcCorte };
});
