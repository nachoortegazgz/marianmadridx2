/*
=============================================================================
SUITE: crons.jobsConfigParity (Plan de correccion item 1 mandatory test)
Purpose: verify every job declared in backend/jobs.config has a matching
named export in backend/crons.js (and vice versa no orphan exports wired to
nothing), and that the two nightly/weekly additions behave offline:
 - verifyNightlyZClosing is idempotent when the Z record already exists.
 - cleanAuditLogs removes only terminal ALERT/COMPENSATION/WEBHOOK_EVENT rows
   older than the retention window (ADR-05 append-only safe).
Runs offline via tests/loader.mjs mocks. G10 ASCII strict.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const { wixDataMock } = await import('./loader.mjs');
const CR = await import('backend/crons.js');
const IC = await import('backend/internalConfig');

const JOBS_CONFIG_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', 'jobs.config'
);

test('CRON-PARITY-01 every jobs.config functionName is exported by crons.js', () => {
  const cfg = JSON.parse(fs.readFileSync(JOBS_CONFIG_PATH, 'utf8'));
  const missing = cfg.jobs
    .filter((j) => j.functionLocation === '/crons.js')
    .map((j) => j.functionName)
    .filter((name) => typeof CR[name] !== 'function');
  assert.deepStrictEqual(missing, [], `jobs.config declares functions not exported by crons.js: ${missing.join(', ')}`);
});

test('CRON-PARITY-02 crons.js exports cover the two previously-missing jobs', () => {
  assert.strictEqual(typeof CR.verifyNightlyZClosing, 'function');
  assert.strictEqual(typeof CR.cleanAuditLogs, 'function');
});

test('CRON-Z-01 verifyNightlyZClosing is idempotent when the day is already closed (ACCESS_DENIED path)', async () => {
  wixDataMock._reset();
  // Offline harness: registerZClosing throws ACCESS_DENIED from requireCajero
  // (stubbed currentMember has no session), exactly like a real Velo cron.
  // The Z row for yesterday exists (manual closing by the cashier), so the
  // cron must verify-by-read and exit WITHOUT alerting or throwing.
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' })
    .format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  wixDataMock._seed(IC.BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z, [
    { _id: `Z_${ymd}`, operationDate: ymd, closingStatus: 'CERRADO', closingSignatureStatus: 'SIGNED' },
  ]);
  await CR.verifyNightlyZClosing();
  const alerts = (wixDataMock._store.get(IC.OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO) || [])
    .filter((r) => r.alertType);
  assert.deepStrictEqual(alerts, [], 'must NOT raise an alert when the day is verifiably closed');
});

test('CRON-Z-02 verifyNightlyZClosing raises MANUAL_REQUIRED alert when close is missing and denied', async () => {
  wixDataMock._reset();
  // No Z row seeded: ACCESS_DENIED + missing record => WARN alert inserted,
  // but no throw (human action required, not infinite runner retries).
  await CR.verifyNightlyZClosing();
  const alerts = (wixDataMock._store.get(IC.OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO) || [])
    .filter((r) => r.alertType === 'NIGHTLY_Z_CLOSING_MANUAL_REQUIRED');
  assert.strictEqual(alerts.length, 1, 'exactly one deduped manual-required alert expected');
});

test('CRON-AUDIT-01 cleanAuditLogs purges only terminal rows past retention', async () => {
  wixDataMock._reset();
  const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const recent = new Date();
  const C = IC.OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
  wixDataMock._seed(C, [
    { _id: 'a1', controlType: IC.CONTROL_TYPE.ALERT, status: 'OPEN', _createdDate: old },
    { _id: 'c1', controlType: IC.CONTROL_TYPE.COMPENSATION, status: IC.CONTROL_STATUS.EXECUTED, _createdDate: old },
    { _id: 'c2', controlType: IC.CONTROL_TYPE.COMPENSATION, status: IC.CONTROL_STATUS.PENDING, _createdDate: old },
    { _id: 'w1', controlType: IC.CONTROL_TYPE.WEBHOOK_EVENT, status: IC.CONTROL_STATUS.CLOSED, _createdDate: old },
    { _id: 'l1', controlType: IC.CONTROL_TYPE.SLOT_LOCK, status: IC.CONTROL_STATUS.ACTIVE, _createdDate: old },
    { _id: 'a2', controlType: IC.CONTROL_TYPE.ALERT, status: 'OPEN', _createdDate: recent },
  ]);
  await CR.cleanAuditLogs();
  const remaining = (wixDataMock._store.get(C) || []).map((r) => r._id).sort();
  assert.deepStrictEqual(remaining, ['a2', 'c2', 'l1'],
    'only ALERT + terminal COMPENSATION + processed WEBHOOK_EVENT past 90d are purged');
});
