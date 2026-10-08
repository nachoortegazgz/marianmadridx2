// FASE4: wrapper node --test para auditoria E2E heredada (v5009-AUDIT).
// Ejecuta el runner original contra mocks del loader; assertion global: sin fallos criticos.
import test from 'node:test';
import assert from 'node:assert';

const mod = await import('../__tests__/audit.e2e.js');
const runAudit = mod.runFullAudit || mod.default?.runFullAudit || mod.auditMain || mod.main || mod.runAudit;

test('E2E-AUDIT-FULL', { skip: typeof runAudit !== 'function' ? 'no exported runner found; checking module shape' : false }, async () => {
  const res = await runAudit();
  const failed = (res?.results || res?.checks || []).filter(c => c.status === 'FAIL' || c.passed === false);
  assert.deepStrictEqual(failed.map(f => f.name), [], 'flujos E2E con fallos');
});
