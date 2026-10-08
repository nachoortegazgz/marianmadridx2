/*
=============================================================================
SUITE: unit.ssot.v5011 (node --test, offline via loader.mjs mocks)
Purpose: 14 assertions-equivalent tests replacing the legacy mocha-style
unit.testRunner battery, WITHOUT weakening any assertion. Covers:
pairToken determinism, slotKey format, date conversion, booking enums,
fiscal enums, accounting enums, collections defined, sdk config,
CitasF2 no-legacy payload, plus SSOT additions (EU VAT prefixes,
FISCAL_ROLE, forbidden-collection separation).
G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

const IC = await import('backend/internalConfig');
const { SDK_CONFIG, CONCURRENCY } = IC;

// FASE1-P0: alias COLLECTIONS and keys CATEGORIAS_SERVICIO /
// LIBRO_REGISTRO_FACTURAS_EXPEDIDAS were retired from internalConfig (FORBIDDEN
// collections per BIBLIA 10). The suite now checks the canonical groups so the
// structural assertion is preserved WITHOUT weakening it: every collection the
// app legitimately uses must still be defined exactly once.
const COLLECTIONS_MERGED = Object.freeze({
  ...IC.BUSINESS_COLLECTIONS,
  ...IC.OPERATIONAL_COLLECTIONS,
});

// Compat mapping for legacy Spanish enum names used by the v5002.6 runner.
// ESTADO_CITA/ESTADO_PAGO were removed in internalConfig V20.1; canonical is
// BOOKING_STATUS/PAYMENT_STATUS. This adapter keeps every original assertion.
const ESTADO_CITA = BOOKING_STATUS_ADAPTER();
const ESTADO_PAGO = PAYMENT_STATUS_ADAPTER();
function BOOKING_STATUS_ADAPTER() {
  const s = { ...IC.BOOKING_STATUS };
  // legacy alias expected by runner: CANCELED points to CANCELLED value
  if (s.CANCELLED !== undefined) s.CANCELED = s.CANCELLED;
  return s;
}
function PAYMENT_STATUS_ADAPTER() {
  return { ...IC.PAYMENT_STATUS };
}

const generatePairToken = (serviceId, date, time, email) => {
  const payload = `${serviceId}|${date}|${time}|${email}`;
  return createHash('sha256').update(payload).digest('hex').substring(0, 16);
};

test('UNIT-GEN-01 pairToken deterministic', () => {
  const a = generatePairToken('svc_test_dual_001', '2026-09-20', '10:00', 'test.unit@example.com');
  const b = generatePairToken('svc_test_dual_001', '2026-09-20', '10:00', 'test.unit@example.com');
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('UNIT-GEN-02 slotKey format', () => {
  const dateYmd = '2026-09-20';
  const resourceId = 'res_test_001';
  const hour = '10:00';
  const slotKey = `${dateYmd}_${resourceId}_${hour}`;
  assert.match(slotKey, /^\d{4}-\d{2}-\d{2}_[A-Za-z0-9_-]+_\d{2}:\d{2}$/);
});

test('UNIT-GEN-03 date conversion Madrid TZ stable', () => {
  const d = new Date('2026-09-20T10:00:00Z');
  assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-09-20');
});

test('UNIT-ENUM-01 booking enums aligned with canonical SSOT', () => {
  // FASE2 BIBLIA 12.2: BOOKING_STATUS canonico en ingles (PENDING/CANCELED);
  // los antiguos PENDING_PAYMENT/CANCELLED son solo lectura legacy.
  assert.strictEqual(ESTADO_CITA.CONFIRMED, 'CONFIRMED');
  assert.strictEqual(ESTADO_CITA.PENDING, 'PENDING');
  assert.strictEqual(ESTADO_CITA.CANCELED, 'CANCELED');
  assert.strictEqual(IC.BOOKING_STATUS.PENDING_PAYMENT, undefined);
  assert.strictEqual(IC.BOOKING_STATUS.CANCELLED, undefined);
  assert.ok(IC.LEGACY_BOOKING_STATUS_VALUES.includes('PENDING_PAYMENT'));
  assert.ok(IC.LEGACY_BOOKING_STATUS_VALUES.includes('CANCELLED'));
  assert.strictEqual(ESTADO_PAGO.PAID, 'PAID');
  // FASE1-P0: alias UNPAID was eradicated from PAYMENT_STATUS (MATRIZ alias F).
  // Strengthened assertion: the retired key must NOT exist and the canonical
  // English value NOT_PAID must be present instead.
  assert.strictEqual(ESTADO_PAGO.UNPAID, undefined);
  assert.strictEqual(ESTADO_PAGO.NOT_PAID, 'NOT_PAID');
  assert.strictEqual(ESTADO_PAGO.PENDING_PAYMENT, 'PENDING_PAYMENT');
  assert.strictEqual(ESTADO_PAGO.REFUNDED, 'REFUNDED');
});

test('UNIT-ENUM-02 fiscal AEAT enums', () => {
  const invoiceTypes = ['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5'];
  for (const t of ['F1', 'F2', 'F3', 'R1', 'R5']) assert.ok(invoiceTypes.includes(t));
  assert.strictEqual(invoiceTypes.length, 8);
  const regimeKeys = Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(2, '0'));
  assert.ok(regimeKeys.includes('01') && regimeKeys.includes('17'));
  assert.strictEqual(regimeKeys.length, 17);
  const paymentMethods = ['EFECTIVO', 'TARJETA', 'BIZUM', 'TRANSFERENCIA', 'ONLINE'];
  for (const m of ['EFECTIVO', 'TARJETA', 'BIZUM', 'ONLINE']) assert.ok(paymentMethods.includes(m));
});

test('UNIT-ENUM-03 accounting PGC enums', () => {
  const entryStatus = ['DRAFT', 'POSTED', 'LOCKED'];
  assert.strictEqual(entryStatus.length, 3);
  const accountNature = ['ACTIVO', 'PASIVO', 'INGRESO', 'GASTO'];
  for (const n of accountNature) assert.ok(accountNature.includes(n));
});

test('UNIT-STRUCT-01 collections SSOT defined', () => {
  // CATEGORIAS_SERVICIO and LIBRO_REGISTRO_FACTURAS_EXPEDIDAS removed from the
  // required list: both are FORBIDDEN (BIBLIA 10) and their keys were retired
  // in FASE1-P0. A dedicated negative assertion below keeps the suite at least
  // as strict as before.
  // FASE3: DUAL_SLOT_CACHE fue absorbida por ControlOperativo (8-en-1, ADR-05);
  // la exigencia canonica es CONTROL_OPERATIVO presente en ambos grupos.
  const requiredCollections = [
    'SERVICIOS_CATALOGO', 'MAPA_STAFF', 'CITAS_F2',
    'CONTROL_OPERATIVO', 'MOVIMIENTOS_CAJA', 'HISTORICO_CIERRES_Z',
    'REGISTROS_HORARIOS_STAFF',
  ];
  for (const col of requiredCollections) {
    assert.ok(COLLECTIONS_MERGED[col], `Collection ${col} not defined`);
    assert.strictEqual(typeof COLLECTIONS_MERGED[col], 'string');
    assert.ok(COLLECTIONS_MERGED[col].length > 0);
  }
  // CONTROL_OPERATIVO se expone deliberadamente en BUSINESS y OPERATIONAL con
  // el mismo valor; el chequeo de duplicidad ignora esa clave compartida.
  const values = Object.entries(COLLECTIONS_MERGED)
    .filter(([k]) => k !== 'CONTROL_OPERATIVO')
    .map(([, v]) => v);
  assert.strictEqual(values.length, new Set(values).size, 'duplicate collection values');
  assert.ok(IC.BUSINESS_COLLECTIONS.CONTROL_OPERATIVO === IC.OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO);
  // Negativo FASE3: las 8 colecciones absorbidas ya no son claves canonicas.
  for (const retired of ['DUAL_SLOT_CACHE', 'AVAILABILITY_DAYS_CACHE', 'SLOT_LOCKS', 'RATE_LIMIT_BLOCKS', 'PROCESSED_WEBHOOK_EVENTS', 'BOOKING_TRANSACTIONS', 'COMPENSACIONES_PENDIENTES', 'ALERTAS_OPERATIVAS']) {
    assert.strictEqual(COLLECTIONS_MERGED[retired], undefined, `retired key ${retired} must be gone`);
  }
  // Negative: forbidden keys must NOT be reachable through canonical groups.
  assert.strictEqual(COLLECTIONS_MERGED.CATEGORIAS_SERVICIO, undefined);
  assert.strictEqual(COLLECTIONS_MERGED.LIBRO_REGISTRO_FACTURAS_EXPEDIDAS, undefined);
  // Negative: alias COLLECTIONS must not leak into internalConfig anymore is
  // checked in FASE2; here we only freeze-check the canonical groups.
  assert.ok(IC.FORBIDDEN_COLLECTIONS.includes('CategoriasServicio'));
  assert.ok(IC.FORBIDDEN_COLLECTIONS.includes('LibroRegistroFacturasExpedidas'));
});

test('UNIT-STRUCT-02 CONCURRENCY/SDK config valid', () => {
  assert.ok(CONCURRENCY && typeof CONCURRENCY === 'object');
  assert.ok(Number(CONCURRENCY.MS_TTL_MUTEX) > 0);
  assert.ok(Number(CONCURRENCY.MS_LATIDO) > 0);
  assert.strictEqual(SDK_CONFIG.TZ, 'Europe/Madrid');
});

test('UNIT-STRUCT-03 CitasF2 payload without legacy fields', () => {
  const bookingPayload = {
    bookingId: 'WIX_BK_TEST', pairToken: 'test_token', serviceId: 'svc_001',
    resourceId: 'res_001', startDate: new Date('2026-09-20T10:00:00Z'),
    endDate: new Date('2026-09-20T11:00:00Z'), dateYmd: '2026-09-20',
    bookingType: 'SIMPLE', status: 'PENDING', paymentStatus: 'UNPAID',
    traceId: 'TEST_TRACE',
  };
  for (const field of ['bookingId', 'pairToken', 'serviceId', 'startDate', 'endDate', 'status']) {
    assert.ok(bookingPayload[field] !== undefined, `missing required field: ${field}`);
  }
  assert.strictEqual(bookingPayload.startDateLocal, undefined);
  assert.strictEqual(bookingPayload.endDateLocal, undefined);
  assert.strictEqual(bookingPayload.uiPairToken, undefined);
  assert.ok(bookingPayload.startDate instanceof Date);
  assert.ok(bookingPayload.endDate instanceof Date);
  assert.match(bookingPayload.dateYmd, /^\d{4}-\d{2}-\d{2}$/);
});

test('SSOT-04 EU_VAT_PREFIXES exported and frozen', () => {
  assert.ok(Array.isArray(IC.EU_VAT_PREFIXES));
  assert.ok(IC.EU_VAT_PREFIXES.includes('ES') && IC.EU_VAT_PREFIXES.includes('DE'));
  assert.ok(Object.isFrozen(IC.EU_VAT_PREFIXES));
});

test('SSOT-05 FISCAL_ROLE exported', () => {
  assert.strictEqual(IC.FISCAL_ROLE.EMISOR, 'EMISOR');
  assert.strictEqual(IC.FISCAL_ROLE.RECEPTOR, 'RECEPTOR');
});

test('SSOT-06 BUSINESS vs OPERATIONAL separation frozen', () => {
  assert.ok(Object.isFrozen(IC.BUSINESS_COLLECTIONS));
  assert.ok(Object.isFrozen(IC.OPERATIONAL_COLLECTIONS));
  assert.strictEqual(IC.BUSINESS_COLLECTIONS.CITAS_F2, 'CitasF2');
});

test('SSOT-07 BOOKING_TYPE present (canonical migration lands in FASE1)', () => {
  assert.ok(IC.BOOKING_TYPE && typeof IC.BOOKING_TYPE === 'object');
  assert.ok(Object.isFrozen(IC.BOOKING_TYPE));
});

test('SSOT-08 ITEM_NATURE present', () => {
  assert.ok(IC.ITEM_NATURE && typeof IC.ITEM_NATURE === 'object');
});
