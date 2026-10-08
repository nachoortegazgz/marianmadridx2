/**
 * controlOperativo.hooks.test.mjs
 * FASE 3 SSOT v7.0 (BIBLIA 12 / ADR-05): validacion condicional de hooks
 * ControlOperativo: WEBHOOK_EVENT append-only, resto purgable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ControlOperativo_beforeInsert,
  ControlOperativo_beforeUpdate,
  ControlOperativo_beforeRemove,
} from "../data.js";
import { CONTROL_TYPE, CONTROL_STATUS } from "../internalConfig.js";

function _base(controlType) {
  return {
    controlType,
    dedupeKey: `${controlType}:unit-test-key`,
    status: CONTROL_STATUS.ACTIVE,
    traceId: "trace-unit-001",
  };
}

describe("ControlOperativo hooks (ADR-05)", () => {
  it("beforeInsert exige controlType valido del enum", () => {
    assert.doesNotThrow(() => ControlOperativo_beforeInsert(_base(CONTROL_TYPE.SLOT_LOCK)));
    assert.throws(
      () => ControlOperativo_beforeInsert({ ..._base("NOT_A_TYPE"), controlType: "NOT_A_TYPE" }),
      /VALIDATION_ERROR.*controlType/,
    );
  });

  it("beforeInsert exige dedupeKey no vacio", () => {
    const bad = _base(CONTROL_TYPE.ALERT);
    bad.dedupeKey = "   ";
    assert.throws(() => ControlOperativo_beforeInsert(bad), /dedupeKey/);
  });

  it("beforeInsert rechaza status fuera de CONTROL_STATUS", () => {
    const bad = _base(CONTROL_TYPE.RATE_LIMIT);
    bad.status = "WHATEVER";
    assert.throws(() => ControlOperativo_beforeInsert(bad), /status/);
  });

  it("WEBHOOK_EVENT es append-only: update prohibido", () => {
    const rec = _base(CONTROL_TYPE.WEBHOOK_EVENT);
    assert.throws(
      () => ControlOperativo_beforeUpdate(rec, { original: rec }),
      /append-only/,
    );
  });

  it("WEBHOOK_EVENT es append-only: remove prohibido", () => {
    const rec = _base(CONTROL_TYPE.WEBHOOK_EVENT);
    assert.throws(() => ControlOperativo_beforeRemove(rec), /Borrado prohibido/);
  });

  it("Subtipos purgables (SLOT_LOCK/DUAL_CACHE) permiten update/remove", () => {
    for (const t of [CONTROL_TYPE.SLOT_LOCK, CONTROL_TYPE.DUAL_CACHE, CONTROL_TYPE.DAYS_CACHE]) {
      const rec = _base(t);
      assert.doesNotThrow(() => ControlOperativo_beforeUpdate(rec, { original: rec }));
      assert.doesNotThrow(() => ControlOperativo_beforeRemove(rec));
    }
  });

  it("CONTROL_TYPE cubre los 8 subtipos del esquema objetivo", () => {
    const expected = [
      "SLOT_LOCK", "WEBHOOK_EVENT", "RATE_LIMIT", "BOOKING_TX",
      "COMPENSATION", "ALERT", "DAYS_CACHE", "DUAL_CACHE",
    ];
    const values = Object.values(CONTROL_TYPE).sort();
    assert.deepEqual(values, expected.sort());
  });
});
