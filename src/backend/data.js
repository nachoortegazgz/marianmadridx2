/*
=============================================================================
MODULE: backend/data.js
VERSION: v11.0-SSOT-CLEAN
BASE: BIBLIA v10.0 §12
RESPONSIBILITY: Integridad de ledgers. CitasF2 eliminacion bloqueada.
=============================================================================
*/

import {
    CONSISTENCY,
    queryFirstItem,
} from "backend/dataAccess";

import {
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    INTEGRITY,
    SINGLETONS,
} from "backend/internalConfig";

import {
    assertCitasF2,
    assertControlOperativo,
    assertRegistrosHorariosStaff,
    assertMovimientosInventario,
    expectedInventoryMagnitude,
    isValidNifOrEuVat,
} from "backend/validation";

const LEDGER_SCHEMA_VERSION = INTEGRITY.LEDGER_SCHEMA_VERSION;

function safeTrim(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

function fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function roundMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) ?
        Math.round((number + Number.EPSILON) * 100) / 100 : 0;
}

// =============================================================================
// MovimientosCaja - append-only (BIBLIA §5.3)
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    if (!safeTrim(item.traceId)) {
        schemaError("MovimientosCaja requires traceId");
    }
    if (safeTrim(item.schemaVersion) !== LEDGER_SCHEMA_VERSION) {
        schemaError(`schemaVersion must be ${LEDGER_SCHEMA_VERSION}`);
    }
    if (!safeTrim(item.recordHash)) {
        schemaError("recordHash is required");
    }
    if (!Number.isFinite(Number(item.sequenceNumber)) || Number(item.sequenceNumber) <= 0) {
        schemaError("sequenceNumber must be > 0");
    }

    // Cuadre fiscal: base + cuota ≈ total (tolerancia 0.02)
    const base = Number(item.taxBase ?? 0) || 0;
    const tax = Number(item.taxAmount ?? 0) || 0;
    const total = Number(item.amount ?? 0) || 0;

    if ((base || tax) && Math.abs(base + tax - total) > 0.02) {
        schemaError("taxBase + taxAmount must equal amount (tolerance 0.02)");
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    fiscalError("MovimientosCaja is append-only. Use AJUSTE or rectificativa.");
}

export function MovimientosCaja_beforeRemove() {
    fiscalError("MovimientosCaja: deletion forbidden (Ley 11/2021).");
}

// =============================================================================
// HistoricoCierresZ - actualizacion restringida a firma (BIBLIA §12.1)
// =============================================================================

const ALLOWED_Z_UPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "verifiedAt",
    "approverUser",
    "_updatedDate",
]);

export function HistoricoCierresZ_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    if (!safeTrim(item.recordDomain)) {
        schemaError("HistoricoCierresZ.recordDomain is required");
    }
    if (!safeTrim(item.traceId)) {
        schemaError("HistoricoCierresZ.traceId is required");
    }
    if (!item.operationDate) {
        schemaError("HistoricoCierresZ.operationDate is required");
    }

    return item;
}

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const original = context?.original || {};
    const changedFields = Object.keys(item || {}).filter(
        key => String(original[key]) !== String(item[key])
    );

    if (!changedFields.every(key => ALLOWED_Z_UPDATE_FIELDS.has(key))) {
        fiscalError("HistoricoCierresZ only allows signature field updates.");
    }
    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    fiscalError("HistoricoCierresZ: deletion forbidden.");
}

// =============================================================================
// RegistrosHorariosStaff - append-only (RD 8/2019)
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    assertRegistrosHorariosStaff(item);
    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    fiscalError("RegistrosHorariosStaff is append-only (RD 8/2019).");
}

export function RegistrosHorariosStaff_beforeRemove() {
    fiscalError("RegistrosHorariosStaff: deletion forbidden (RD 8/2019).");
}

// =============================================================================
// CajaActual - singleton protegido
// =============================================================================

export function CajaActual_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const id = safeTrim(item._id);
    if (id !== SINGLETONS.CAJA_PRINCIPAL && id !== SINGLETONS.CAJA_SEQ) {
        schemaError("CajaActual._id must be CAJA_PRINCIPAL or CAJA_SEQ");
    }
    if (!safeTrim(item.traceId)) {
        schemaError("CajaActual requires traceId");
    }
    return item;
}

export function CajaActual_beforeUpdate(item, context) {
    const original = context?.original || {};
    const previousCounters = JSON.stringify(original.sequenceCounters || {});
    const nextCounters = JSON.stringify(item?.sequenceCounters || {});

    if (previousCounters !== nextCounters && safeTrim(item?._id) !== SINGLETONS.CAJA_SEQ) {
        schemaError("sequenceCounters only modifiable in CAJA_SEQ singleton");
    }
    return item;
}

export function CajaActual_beforeRemove() {
    fiscalError("CajaActual: singleton cannot be deleted.");
}

// =============================================================================
// LibroAsientosContablesDetalle - append-only (PGC)
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    if (!safeTrim(item.traceId)) {
        schemaError("LibroAsientosContablesDetalle requires traceId");
    }

    const accountCode = safeTrim(item.accountCode);
    if (accountCode && !/^\d{6}$/.test(accountCode)) {
        schemaError("accountCode must be 6 digits");
    }

    return item;
}

export function LibroAsientosContablesDetalle_beforeUpdate() {
    fiscalError("LibroAsientosContablesDetalle is append-only (PGC).");
}

export function LibroAsientosContablesDetalle_beforeRemove() {
    fiscalError("LibroAsientosContablesDetalle: deletion forbidden.");
}

// =============================================================================
// CitasF2 - CORREGIDO: eliminacion BLOQUEADA (BIBLIA §12.1)
// =============================================================================

export function CitasF2_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    assertCitasF2(item);
    return item;
}

export function CitasF2_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    assertCitasF2(item);
    return item;
}

export function CitasF2_beforeRemove() {
    fiscalError("CitasF2 is append-only. Deletion forbidden.");
}

// =============================================================================
// MovimientosInventario - append-only
// =============================================================================

export async function MovimientosInventario_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertMovimientosInventario(item);

    if (item.magnitude === undefined || item.magnitude === null || item.magnitude === "") {
        item.magnitude = expectedInventoryMagnitude(item.movementType, item.quantityDelta);
    }

    const token = safeTrim(item.movementToken);
    const existing = await queryFirstItem({
        dataCollectionId: OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
        filter: { movementToken: { $eq: token } },
        consistency: CONSISTENCY.STRONG,
    });

    if (existing) {
        fiscalError("movementToken duplicated in MovimientosInventario.");
    }

    return item;
}

export function MovimientosInventario_beforeUpdate() {
    fiscalError("MovimientosInventario is append-only.");
}

export function MovimientosInventario_beforeRemove() {
    fiscalError("MovimientosInventario: deletion forbidden.");
}

// =============================================================================
// ControlOperativo - WEBHOOK_EVENT append-only (ADR-05)
// =============================================================================

export function ControlOperativo_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    assertControlOperativo(item);
    return item;
}

export function ControlOperativo_beforeUpdate(item, context) {
    const original = context?.original || item;
    if (safeTrim(original?.controlType) === CONTROL_TYPE.WEBHOOK_EVENT) {
        fiscalError("WEBHOOK_EVENT is append-only.");
    }
    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (safeTrim(item?.controlType) === CONTROL_TYPE.WEBHOOK_EVENT) {
        fiscalError("WEBHOOK_EVENT: deletion forbidden.");
    }
    return item;
}

// =============================================================================
// InventarioStockVenta - invariante aritmetica (BIBLIA §5.12)
// =============================================================================

function validateStock(item) {
    const onHand = Number(item.stockOnHand);
    const reserved = Number(item.stockReserved ?? 0);
    const available = Number(item.stockAvailable);

    if (Number.isFinite(onHand) && onHand < 0) {
        schemaError("stockOnHand cannot be negative");
    }
    if (Number.isFinite(reserved) && reserved < 0) {
        schemaError("stockReserved cannot be negative");
    }
    if (
        Number.isFinite(onHand) &&
        Number.isFinite(available) &&
        Math.abs(onHand - reserved - available) > 0.001
    ) {
        schemaError("stockAvailable must equal stockOnHand - stockReserved");
    }
    return item;
}

export function InventarioStockVenta_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    return validateStock(item);
}

export function InventarioStockVenta_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    return validateStock(item);
}

export function InventarioStockVenta_beforeRemove(item) {
    return item;
}

// =============================================================================
// Colecciones prohibidas (BIBLIA §6 - legacy eliminadas)
// =============================================================================

export function FacturasRecibidas_beforeInsert() {
    fiscalError("FacturasRecibidas is retired. Use MovimientosCaja with fiscalRole=RECEPTOR.");
}
export function FacturasRecibidas_beforeUpdate() {
    fiscalError("FacturasRecibidas is retired.");
}
export function FacturasRecibidas_beforeRemove() {
    fiscalError("FacturasRecibidas is retired.");
}

export function AsientosContables_beforeInsert() {
    fiscalError("AsientosContables is retired. Use LibroAsientosContablesDetalle.");
}
export function AsientosContables_beforeUpdate() {
    fiscalError("AsientosContables is retired.");
}
export function AsientosContables_beforeRemove() {
    fiscalError("AsientosContables is retired.");
}

export function ConfiguracionFiscal_beforeInsert() {
    fiscalError("Use DatosFiscales with recordType=CONFIG_SISTEMA.");
}
export function ConfiguracionFiscal_beforeUpdate() {
    fiscalError("Use DatosFiscales with recordType=CONFIG_SISTEMA.");
}
export function ConfiguracionFiscal_beforeRemove() {
    fiscalError("Use DatosFiscales with recordType=CONFIG_SISTEMA.");
}
