/*
=============================================================================
SUITE: data.hooks (FASE2 mandatory test)
Purpose: verify CitasF2 rejects invalid enum / missing traceId / dual without
pairToken; MovimientosInventario and ProcessedWebhookEvents are append-only;
MovimientosCaja rejects writes without traceId/schemaVersion.
Runs offline via tests/loader.mjs mocks. G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';

const { wixDataMock } = await import('./loader.mjs');
const H = await import('backend/data');
const IC = await import('backend/internalConfig');

const VALID_CITA = () => ({
  bookingId: 'BK-TEST-001',
  traceId: 'trace-test-001',
  bookingStatus: IC.BOOKING_STATUS.CONFIRMED,
  paymentStatus: IC.PAYMENT_STATUS.NOT_PAID,
  bookingType: IC.BOOKING_TYPE.SIMPLE,
});

// -----------------------------------------------------------------------------
// CitasF2 hooks (SSOT 13.2)
// -----------------------------------------------------------------------------

test('HOOK-CITAS-01 valid simple cita passes insert/update', () => {
  const item = VALID_CITA();
  assert.strictEqual(H.CitasF2_beforeInsert(item), item);
  assert.strictEqual(H.CitasF2_beforeUpdate(item), item);
});

test('HOOK-CITAS-02 invalid bookingStatus rejected', () => {
  const item = { ...VALID_CITA(), bookingStatus: 'CONFIRMADO' };
  // normalizer de lectura convierte CONFIRMADO->CONFIRMED, por lo que debe PASAR.
  assert.doesNotThrow(() => H.CitasF2_beforeInsert(item));
  const bad = { ...VALID_CITA(), bookingStatus: 'ESTADO_INVENTADO' };
  assert.throws(() => H.CitasF2_beforeInsert(bad), /VALIDATION_ERROR/);
});

test('HOOK-CITAS-03 missing traceId rejected (SSOT-12)', () => {
  const item = VALID_CITA();
  delete item.traceId;
  assert.throws(() => H.CitasF2_beforeInsert(item), /traceId/);
});

test('HOOK-CITAS-04 DUALF1/DUALF2 without pairToken rejected', () => {
  for (const t of [IC.BOOKING_TYPE.DUALF1, IC.BOOKING_TYPE.DUALF2]) {
    const item = { ...VALID_CITA(), bookingType: t };
    assert.throws(() => H.CitasF2_beforeInsert(item), /pairToken/);
    const ok = { ...item, pairToken: 'pair-abc' };
    assert.doesNotThrow(() => H.CitasF2_beforeInsert(ok));
  }
});

test('HOOK-CITAS-05 legacy Spanish payment status normalized on read', () => {
  const item = { ...VALID_CITA(), paymentStatus: 'PAGADO' };
  assert.doesNotThrow(() => H.CitasF2_beforeInsert(item));
});

// -----------------------------------------------------------------------------
// Append-only (SSOT 13.1)
// -----------------------------------------------------------------------------

test('HOOK-APPEND-01 MovimientosInventario update/remove blocked', () => {
  assert.throws(() => H.MovimientosInventario_beforeUpdate({}), /append-only/);
  assert.throws(() => H.MovimientosInventario_beforeRemove({}), /Borrado prohibido/);
});

test('HOOK-APPEND-02 retired blocked-collection hooks are gone (ADR-02)', () => {
  assert.strictEqual(H.SecuenciaTickets_beforeUpdate, undefined);
  assert.strictEqual(H.InventarioStockVentaCierre_beforeUpdate, undefined);
  assert.strictEqual(H.InventarioStockVentaCierre_beforeRemove, undefined);
});

// -----------------------------------------------------------------------------
// MovimientosCaja hardening (traceId + schemaVersion)
// -----------------------------------------------------------------------------

function cajaBase() {
  return {
    eventType: IC.EVENT_TYPE ? Object.values(IC.EVENT_TYPE)[0] : 'VENTA_LINEA',
    movementType: Object.values(IC.MOVEMENT_TYPE)[0],
    totalAmount: 100,
    thirdPartyId: null,
    schemaVersion: 'LEDGER_V5_FISCAL',
    traceId: 'trace-caja-001',
  };
}

// Fixture minimo VALID para CIERRE_Z segun data.js: thirdPartyId/fiscalPayload
// exentos, pero sequenceNumber + recordHash son obligatorios en toda escritura
// del ledger (capa AEAT V5). Se completan aqui sin debilitar la assertion:
// el test sigue verificando que falta traceId, no que el resto pase de rebote.
function cajaCierreZ() {
  return {
    ...cajaBase(),
    eventType: 'CIERRE_Z',
    sequenceNumber: 1,
    recordHash: 'a'.repeat(64),
    previousRecordHash: null,
  };
}

test('HOOK-CAJA-01 rejects write without traceId', () => {
  const item = cajaCierreZ();
  delete item.traceId;
  assert.throws(() => H.MovimientosCaja_beforeInsert(item), /traceId obligatorio/);
});

test('HOOK-CAJA-02 rejects wrong schemaVersion', () => {
  const item = { ...cajaCierreZ(), schemaVersion: 'OTHER' };
  assert.throws(() => H.MovimientosCaja_beforeInsert(item), /schemaVersion/);
});

test('HOOK-CAJA-04 accepts valid CIERRE_Z baseline', () => {
  assert.doesNotThrow(() => H.MovimientosCaja_beforeInsert(cajaCierreZ()));
});

test('HOOK-CAJA-03 update/remove remain forbidden', () => {
  assert.throws(() => H.MovimientosCaja_beforeUpdate({}), /FISCAL_VIOLATION/);
  assert.throws(() => H.MovimientosCaja_beforeRemove({}), /FISCAL_VIOLATION/);
});

// -----------------------------------------------------------------------------
// InventarioStockVenta invariant
// -----------------------------------------------------------------------------

test('HOOK-STOCK-01 stockAvailable must equal onHand - reserved', () => {
  assert.doesNotThrow(() => H.InventarioStockVenta_beforeUpdate({
    stockOnHand: 10, stockReserved: 3, stockAvailable: 7,
  }));
  assert.throws(() => H.InventarioStockVenta_beforeUpdate({
    stockOnHand: 10, stockReserved: 3, stockAvailable: 9,
  }), /stockAvailable/);
});

// -----------------------------------------------------------------------------
// RegistrosHorariosStaff beforeInsert
// -----------------------------------------------------------------------------

test('HOOK-CLOCK-01 invalid clockEventType rejected', () => {
  assert.throws(() => H.RegistrosHorariosStaff_beforeInsert({
    clockEventType: 'EXCESO', traceId: 't1',
  }), /clockEventType/);
});

test('HOOK-CLOCK-02 AJUSTE requires adjustmentReason', () => {
  assert.throws(() => H.RegistrosHorariosStaff_beforeInsert({
    clockEventType: IC.TIMECLOCK_TYPE.AJUSTE, traceId: 't1',
  }), /adjustmentReason/);
  assert.doesNotThrow(() => H.RegistrosHorariosStaff_beforeInsert({
    clockEventType: IC.TIMECLOCK_TYPE.AJUSTE, adjustmentReason: 'Correccion manual jornada', traceId: 't1',
  }));
});

test('HOOK-CLOCK-03 missing traceId rejected', () => {
  assert.throws(() => H.RegistrosHorariosStaff_beforeInsert({
    clockEventType: IC.TIMECLOCK_TYPE.ENTRADA,
  }), /traceId/);
});

// keep wixDataMock referenced so loader seeds reset between suites
test('HOOK-MOCK-00 loader mock available', () => {
  wixDataMock._reset();
  assert.ok(true);
});
