/*
=============================================================================
SUITE: dto.whitelist (FASE3/4 mandatory contract test)
Purpose: no public webMethod response may leak internal/fiscal fields:
margin, internalNotes, tipoImpositivo, codigoImpuesto, payloadFiscal,
nifEmisor, cuentaContable*, previousRecordHash. recordHash is ONLY allowed
in the Verifactu receipt DTO (AEAT public QR contract).
Runs offline via tests/loader.mjs mocks. G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';

const { wixDataMock } = await import('./loader.mjs');
// ADR-06 Etapa A: convencion unica backend/<modulo>.web.js (incl. tests)
const RW = await import('backend/reservas.web.js');
const CW = await import('backend/cajas.web.js');
const IC = await import('backend/internalConfig');

const FORBIDDEN_KEYS = [
  'margin', 'internalNotes', 'tipoImpositivo', 'codigoImpuesto',
  'payloadFiscal', 'nifEmisor', 'previousRecordHash',
  'cuentaContableContrapartida', 'cuentaContableCliente', 'cuentaContableIngresos',
];

function _deepKeys(obj, acc = []) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      acc.push(k);
      _deepKeys(obj[k], acc);
    }
  }
  return acc;
}

test('DTO-01 getConfirmedBookingForDisplay returns whitelisted DTO only', async () => {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r1',
    bookingId: 'BK-77',
    bookingStatus: 'CONFIRMED',
    paymentStatus: 'PAID',
    pairToken: 'PT-1',
    serviceId: 'SVC-9',
    dateYmd: '2026-10-05',
    slotStart: '2026-10-05T10:00:00Z',
    slotEnd: '2026-10-05T11:00:00Z',
    resourceId: 'RES-2',
    totalPrice: 4500,
    // fields that MUST NOT leak:
    margin: 1200,
    internalNotes: 'notas internas',
    tipoImpositivo: 21,
    payloadFiscal: { x: 1 },
    nifEmisor: 'B12345678',
    previousRecordHash: 'abc',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-77' });
  assert.strictEqual(res.ok, true);
  const keys = _deepKeys(res.data);
  for (const bad of FORBIDDEN_KEYS) {
    assert.ok(!keys.includes(bad), `leaked forbidden key: ${bad}`);
  }
  assert.strictEqual(res.data.bookingId, 'BK-77');
  assert.strictEqual(res.data.bookingStatus, 'CONFIRMED');
});

test('DTO-02 legacy status row readable via canonical projection', async () => {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r2', bookingId: 'BK-78', status: 'CONFIRMED', paymentStatus: 'PAID',
    totalPrice: 30, internalNotes: 'x',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-78' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.bookingStatus, 'CONFIRMED');
  assert.ok(!_deepKeys(res.data).includes('internalNotes'));
});

test('DTO-03 non-displayable booking states are hidden', async () => {
  wixDataMock._reset();
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.CITAS_F2, [{
    _id: 'r3', bookingId: 'BK-79', bookingStatus: 'CANCELED',
  }]);
  const res = await RW.getConfirmedBookingForDisplay({ bookingId: 'BK-79' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'NOT_CONFIRMED');
});

test('DTO-04 getMovimientoByBooking exposes only receipt-safe fields', async () => {
  wixDataMock._reset();
  const mod = await import('backend/cajas.web.js');
  // canonical serialized linkedBookingIds produced by _linkedBookingValue([id])
  const seed = [{
    _id: 'm1',
    invoiceNumber: 'EM-2026-10-00000001',
    issuerTaxId: 'B99999999',
    invoiceIssueDate: '2026-10-05',
    totalAmount: 45,
    recordHash: 'HASH1',
    recordTimestamp: '2026-10-05T10:05:00Z',
    operationDescription: 'Cobro reserva BK-80',
    linkedBookingIds: 'BK-80',
    // must not leak:
    tipoImpositivo: 21,
    codigoImpuesto: 'S1',
    payloadFiscal: { firma: 'x' },
    cuentaContableIngresos: '4300',
    previousRecordHash: 'GENESIS',
    internalNotes: 'no publico',
  }];
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, seed);
  const res = await mod.getMovimientoByBooking({ bookingId: 'BK-80' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const keys = _deepKeys(res.data);
  for (const bad of ['tipoImpositivo', 'codigoImpuesto', 'payloadFiscal',
    'cuentaContableIngresos', 'previousRecordHash', 'internalNotes']) {
    assert.ok(!keys.includes(bad), `leaked: ${bad}`);
  }
  assert.strictEqual(res.data.recordHash, 'HASH1'); // AEAT QR contract field
});

test('DTO-05 missing bookingId rejected without CMS call', async () => {
  wixDataMock._reset();
  const before = wixDataMock._calls.length;
  const a = await RW.getConfirmedBookingForDisplay({});
  const b = await CW.getMovimientoByBooking({});
  assert.strictEqual(a.ok, false);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(wixDataMock._calls.length, before);
});
