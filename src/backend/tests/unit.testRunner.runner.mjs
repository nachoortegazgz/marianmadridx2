// FASE4: wrapper node --test para la bateria unitaria heredada (9 tests).
// No reescribe assertions: ejecuta runAllUnitTests y mapea cada resultado a test().
import test from 'node:test';
import assert from 'node:assert';
import {
  runAllUnitTests,
  testPairTokenDeterministic,
  testSlotKeyFormat,
  testDateConversion,
  testBookingEnums,
  testFiscalEnums,
  testAccountingEnums,
  testCollectionsDefined,
  testSdkConfig,
  testCitasF2NoLegacy
} from '../__tests__/unit.testRunner.js';

const battery = [
  ['UNIT-TOKEN-01', testPairTokenDeterministic],
  ['UNIT-SLOTKEY-01', testSlotKeyFormat],
  ['UNIT-DATE-01', testDateConversion],
  ['UNIT-ENUM-01', testBookingEnums],
  ['UNIT-ENUM-02', testFiscalEnums],
  ['UNIT-ENUM-03', testAccountingEnums],
  ['UNIT-STRUCT-01', testCollectionsDefined],
  ['UNIT-STRUCT-02', testSdkConfig],
  ['UNIT-STRUCT-03', testCitasF2NoLegacy]
];

for (const [id, fn] of battery) {
  test(id, async () => {
    const r = await fn();
    assert.strictEqual(r.status, 'PASS', `${id}: ${r.message || ''}`);
  });
}

test('UNIT-RUNNER-SUMMARY', async () => {
  const summary = await runAllUnitTests();
  assert.strictEqual(summary.failed, 0, `fallos: ${JSON.stringify(summary.details.filter(d => d.status !== 'PASS'))}`);
});
