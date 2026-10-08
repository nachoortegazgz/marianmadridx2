/*
=============================================================================
MODULE: backend/data.js
VERSION: v10.1-SSOT-FRICTIONLESS
RESPONSIBILITY: Integridad de ledgers fiscales, laborales, contables
y operativos.

Las colecciones maestras no tienen hooks en este modulo:
ServiciosCatalogo, ComplementosCatalogo, MapaStaff, DatosFiscales.

Las escrituras de esas colecciones se validan en sus consumidores.
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

// =============================================================================
// HELPERS
// =============================================================================

const LEDGER_SCHEMA_VERSION = INTEGRITY.LEDGER_SCHEMA_VERSION;
const IMMUTABLE_ENTRY_STATUSES = new Set(["POSTED", "LOCKED"]);

const ALLOWED_Z_UPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "verifiedAt",
    "approverUser",
    "_updatedDate",
]);

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
        Math.round((number + Number.EPSILON) * 100) / 100 :
        0;
}

function readTaxableBase(item) {
    return Number(
        item.taxableBaseOrNonSubjectAmount ??
        item.baseImponibleOImporteNoSujeto ??
        item.taxableAmount ??
        0
    ) || 0;
}

function readTaxAmount(item) {
    return Number(item.taxAmount ?? item.cuotaTotal ?? 0) || 0;
}

function readTotalAmount(item) {
    return Number(
        item.totalAmount ?? item.importeTotal ?? item.amount ?? 0
    ) || 0;
}

function readSurchargeAmount(item) {
    return Number(
        item.surchargeAmount ??
        item.cuotaRecargoEquivalencia ??
        item.importeRecargoEquivalencia ??
        0
    ) || 0;
}

function readRecipientTaxId(item) {
    return safeTrim(
        item.recipientTaxId || item.nifDestinatario || item.nifTercero
    );
}

function readBreakdown(item) {
    const raw =
        item.detailedBreakdown ||
        item.desgloseDetallado ||
        item.desgloseImpuestos ||
        item.lineItems;

    if (!raw) return { base: 0, tax: 0 };

    let rows;
    try {
        rows = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
        schemaError("El desglose fiscal no contiene JSON valido");
    }

    if (!Array.isArray(rows)) {
        schemaError("El desglose fiscal debe ser una lista");
    }

    return rows.reduce(
        (totals, row) => ({
            base: totals.base + Number(
                row.taxableBaseOrNonSubjectAmount ??
                row.baseImponibleOImporteNoSujeto ??
                row.base ??
                0
            ),
            tax: totals.tax + Number(
                row.chargedTaxAmount ??
                row.cuotaRepercutida ??
                row.cuota ??
                0
            ),
        }), { base: 0, tax: 0 }
    );
}

function validateInvoiceRequirements(item) {
    const invoiceType = safeTrim(
        item.invoiceType ||
        item.tipoFactura ||
        item.claveRegistroFactura
    ).toUpperCase();

    if (invoiceType === "F1") {
        const payload = item.fiscalPayload || item.payloadFiscal || {};
        const taxId =
            readRecipientTaxId(item) ||
            safeTrim(payload.nifDestinatario);
        const legalName = safeTrim(
            item.recipientLegalName ||
            item.nombreRazonDestinatario ||
            item.razonSocialTercero ||
            payload.nombreRazonDestinatario
        );
        const address =
            item.recipientAddress ||
            payload.domicilioDestinatario || {};

        if (!taxId) {
            schemaError("Factura F1 requiere identificacion del destinatario");
        }
        if (!legalName) {
            schemaError("Factura F1 requiere nombre legal del destinatario");
        }
        if (!safeTrim(address.cp)) {
            schemaError("Factura F1 requiere codigo postal del destinatario");
        }
    }

    if (
        invoiceType.startsWith("R") &&
        !safeTrim(item.previousInvoiceId)
    ) {
        schemaError("Factura rectificativa requiere previousInvoiceId");
    }

    if (
        safeTrim(item.eventType).toUpperCase() === "AJUSTE" &&
        !safeTrim(item.previousInvoiceId)
    ) {
        schemaError("El evento AJUSTE requiere previousInvoiceId");
    }
}

function validateFiscalPayload(item) {
    if (safeTrim(item.schemaVersion) !== LEDGER_SCHEMA_VERSION) return;

    const eventType = safeTrim(item.eventType).toUpperCase();
    if (!eventType) return;

    if (eventType !== "CIERRE_Z") {
        if (!safeTrim(item.thirdPartyId)) {
            schemaError("thirdPartyId es obligatorio en el registro fiscal");
        }
        if (!item.fiscalPayload || typeof item.fiscalPayload !== "object") {
            schemaError("fiscalPayload es obligatorio en el registro fiscal");
        }
    }

    const eventsRequiringCatalog = [
        "VENTA_LINEA",
        "COMPRA_LINEA",
        "RECTIFICATIVA",
        "MOV_STOCK",
    ];

    if (
        eventsRequiringCatalog.includes(eventType) &&
        !safeTrim(item.catalogId)
    ) {
        schemaError("catalogId es obligatorio para este evento fiscal");
    }

    if (
        !Number.isFinite(Number(item.sequenceNumber)) ||
        Number(item.sequenceNumber) <= 0
    ) {
        schemaError("sequenceNumber debe ser mayor que cero");
    }

    if (!safeTrim(item.recordHash)) {
        schemaError("recordHash es obligatorio");
    }
}

// =============================================================================
// MovimientosCaja - append-only
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const taxId = readRecipientTaxId(item);
    if (taxId && !isValidNifOrEuVat(taxId)) {
        schemaError("Identificacion fiscal del destinatario no valida");
    }

    const breakdown = readBreakdown(item);
    const base = breakdown.base > 0 ?
        breakdown.base :
        readTaxableBase(item);
    const tax = breakdown.tax > 0 ?
        breakdown.tax :
        readTaxAmount(item);
    const withholding = Number(
        item.irpfWithholdingAmount ||
        item.importeRetencionIRPF ||
        0
    ) || 0;
    const surcharge = readSurchargeAmount(item);
    const total = readTotalAmount(item);
    const role = safeTrim(item.fiscalRole || item.rolFiscal).toUpperCase();
    const withholdingSign = role === "RECEPTOR" ? 1 : -1;

    if (base || tax || withholding || surcharge) {
        const expected = roundMoney(
            base + tax + surcharge + withholdingSign * withholding
        );

        if (Math.abs(expected - total) > 0.02) {
            schemaError(
                "El total fiscal no cuadra con la base, impuestos y retencion"
            );
        }
    }

    if (
        item.reverseCharge === true ||
        item.inversionSujetoPasivo === true
    ) {
        if (readTaxAmount(item) > 0) {
            schemaError("La inversion del sujeto pasivo requiere cuota cero");
        }
    }

    validateInvoiceRequirements(item);
    validateFiscalPayload(item);

    if (
        Array.isArray(item.detailedBreakdown) &&
        item.detailedBreakdown.length > 0
    ) {
        const sumBase = item.detailedBreakdown.reduce(
            (sum, row) =>
            sum +
            Number(
                row.taxableBaseOrNonSubjectAmount ??
                row.base ??
                0
            ),
            0
        );
        const sumTax = item.detailedBreakdown.reduce(
            (sum, row) =>
            sum + Number(row.chargedTaxAmount ?? row.cuota ?? 0),
            0
        );

        if (Math.abs(roundMoney(sumBase) - base) > 0.02) {
            schemaError("La base del desglose no coincide con la cabecera");
        }
        if (Math.abs(roundMoney(sumTax) - tax) > 0.02) {
            schemaError("La cuota del desglose no coincide con la cabecera");
        }
    }

    if (item.catalogId) {
        const payloadRegime = safeTrim(
            item.fiscalPayload?.claveRegimen
        );
        const itemRegime = safeTrim(item.regimeKey);

        if (
            payloadRegime &&
            itemRegime &&
            payloadRegime !== itemRegime
        ) {
            schemaError(
                "regimeKey no coincide con fiscalPayload.claveRegimen"
            );
        }
    }

    if (!safeTrim(item.traceId)) {
        schemaError("MovimientosCaja requiere traceId");
    }
    if (safeTrim(item.schemaVersion) !== LEDGER_SCHEMA_VERSION) {
        schemaError(`schemaVersion debe ser ${LEDGER_SCHEMA_VERSION}`);
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    fiscalError(
        "MovimientosCaja es append-only. Registre un ajuste o rectificativa."
    );
}

export function MovimientosCaja_beforeRemove() {
    fiscalError("No se permite borrar movimientos fiscales.");
}

// =============================================================================
// HistoricoCierresZ - actualizacion restringida a firma
// =============================================================================

export function HistoricoCierresZ_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    if (!safeTrim(item.recordDomain)) {
        schemaError("HistoricoCierresZ.recordDomain es obligatorio");
    }
    if (!safeTrim(item.traceId)) {
        schemaError("HistoricoCierresZ.traceId es obligatorio");
    }
    if (!item.operationDate) {
        schemaError("HistoricoCierresZ.operationDate es obligatorio");
    }

    const start = Number(item.startSequence);
    const end = Number(item.endSequence);

    if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end < start
    ) {
        schemaError("endSequence no puede ser menor que startSequence");
    }

    return item;
}

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const original = context?.original || {};
    const changedFields = Object.keys(item || {}).filter(
        key => String(original[key]) !== String(item[key])
    );

    if (
        !changedFields.every(key => ALLOWED_Z_UPDATE_FIELDS.has(key))
    ) {
        fiscalError(
            "HistoricoCierresZ solo permite actualizar campos de firma."
        );
    }

    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    fiscalError("No se permite borrar cierres Z.");
}

// =============================================================================
// RegistrosHorariosStaff - append-only
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertRegistrosHorariosStaff(item);
    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    fiscalError(
        "RegistrosHorariosStaff es append-only. Use un ajuste justificado."
    );
}

export function RegistrosHorariosStaff_beforeRemove() {
    fiscalError("No se permite borrar registros horarios.");
}

// =============================================================================
// CajaActual - singleton protegido
// =============================================================================

export function CajaActual_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const id = safeTrim(item._id);
    if (
        id !== SINGLETONS.CAJA_PRINCIPAL &&
        id !== SINGLETONS.CAJA_SEQ
    ) {
        schemaError("CajaActual._id no corresponde a un singleton permitido");
    }

    if (!safeTrim(item.traceId)) {
        schemaError("CajaActual requiere traceId");
    }

    return item;
}

export function CajaActual_beforeUpdate(item, context) {
    const original = context?.original || {};
    const previousCounters = JSON.stringify(
        original.sequenceCounters || {}
    );
    const nextCounters = JSON.stringify(
        item?.sequenceCounters || {}
    );

    if (
        previousCounters !== nextCounters &&
        safeTrim(item?._id) !== SINGLETONS.CAJA_SEQ
    ) {
        schemaError(
            "sequenceCounters solo se modifica en el singleton de secuencia"
        );
    }

    return item;
}

export function CajaActual_beforeRemove() {
    fiscalError("No se puede eliminar el singleton de caja.");
}

// =============================================================================
// LibroAsientosContablesDetalle - integridad de linea
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const accountCode = safeTrim(
        item.accountCode || item.cuentaContable
    );

    if (accountCode && !/^\d{6}$/.test(accountCode)) {
        schemaError("accountCode debe tener seis digitos");
    }

    if (
        safeTrim(item.schemaVersion) === LEDGER_SCHEMA_VERSION ||
        safeTrim(item.sourceEventId || item.eventoOrigenId)
    ) {
        if (!safeTrim(item.sourceEventId || item.eventoOrigenId)) {
            schemaError("sourceEventId es obligatorio");
        }
        if (!safeTrim(item.thirdPartyId || item.terceroId)) {
            schemaError("thirdPartyId es obligatorio");
        }
        if (!safeTrim(item.catalogId || item.catalogoId)) {
            schemaError("catalogId es obligatorio");
        }

        const lineNumber = Number(
            item.lineNumber ?? item.numeroLinea
        );
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
            schemaError("lineNumber debe ser mayor o igual que uno");
        }

        if (!Number.isFinite(Number(item.units)) || Number(item.units) <= 0) {
            schemaError("units debe ser mayor que cero");
        }

        if (
            !safeTrim(
                item.operationDescription || item.descripcionOperacion
            )
        ) {
            schemaError("operationDescription es obligatoria");
        }
    }

    if (!safeTrim(item.traceId)) {
        schemaError("LibroAsientosContablesDetalle requiere traceId");
    }

    return item;
}

function validateAccountingLineParent(item) {
    const status = safeTrim(item?.parentEntryStatus).toUpperCase();

    if (IMMUTABLE_ENTRY_STATUSES.has(status)) {
        fiscalError(
            "No se puede modificar ni borrar una linea de asiento cerrado."
        );
    }

    return item;
}

export function LibroAsientosContablesDetalle_beforeUpdate(item) {
    return validateAccountingLineParent(item);
}

export function LibroAsientosContablesDetalle_beforeRemove(item) {
    return validateAccountingLineParent(item);
}

// =============================================================================
// CitasF2 - proyeccion operativa
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

export function CitasF2_beforeRemove(item) {
    return item;
}

// =============================================================================
// MovimientosInventario - append-only e idempotencia
// =============================================================================

export async function MovimientosInventario_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertMovimientosInventario(item);

    if (
        item.magnitude === undefined ||
        item.magnitude === null ||
        item.magnitude === ""
    ) {
        item.magnitude = expectedInventoryMagnitude(
            item.movementType,
            item.quantityDelta
        );
    }

    const token = safeTrim(item.movementToken);
    const existing = await queryFirstItem({
        dataCollectionId: OPERATIONAL_COLLECTIONS.MOVIMIENTOS_INVENTARIO,
        filter: {
            movementToken: { $eq: token },
        },
        consistency: CONSISTENCY.STRONG,
    });

    if (existing) {
        fiscalError(
            "movementToken duplicado en MovimientosInventario."
        );
    }

    return item;
}

export function MovimientosInventario_beforeUpdate() {
    fiscalError("MovimientosInventario es append-only.");
}

export function MovimientosInventario_beforeRemove() {
    fiscalError("No se permite borrar movimientos de inventario.");
}

// =============================================================================
// ControlOperativo - WEBHOOK_EVENT append-only
// =============================================================================

export function ControlOperativo_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertControlOperativo(item);
    return item;
}

export function ControlOperativo_beforeUpdate(item, context) {
    const original = context?.original || item;

    if (
        safeTrim(original?.controlType) ===
        CONTROL_TYPE.WEBHOOK_EVENT
    ) {
        fiscalError("WEBHOOK_EVENT es append-only.");
    }

    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (
        safeTrim(item?.controlType) ===
        CONTROL_TYPE.WEBHOOK_EVENT
    ) {
        fiscalError("No se permite borrar WEBHOOK_EVENT.");
    }

    return item;
}

// =============================================================================
// InventarioStockVenta - invariante aritmetica
// =============================================================================

function validateStock(item) {
    const onHand = Number(item.stockOnHand);
    const reserved = Number(item.stockReserved ?? 0);
    const available = Number(item.stockAvailable);

    if (Number.isFinite(onHand) && onHand < 0) {
        schemaError("stockOnHand no puede ser negativo");
    }
    if (Number.isFinite(reserved) && reserved < 0) {
        schemaError("stockReserved no puede ser negativo");
    }

    if (
        Number.isFinite(onHand) &&
        Number.isFinite(available) &&
        Math.abs(onHand - reserved - available) > 0.001
    ) {
        schemaError(
            "stockAvailable debe ser stockOnHand menos stockReserved"
        );
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
// Colecciones prohibidas (SSOT-09)
// =============================================================================

export function FacturasRecibidas_beforeInsert() {
    fiscalError(
        "FacturasRecibidas esta retirada. Use el ledger fiscal aprobado."
    );
}
export function FacturasRecibidas_beforeUpdate() {
    fiscalError("FacturasRecibidas esta retirada.");
}
export function FacturasRecibidas_beforeRemove() {
    fiscalError("FacturasRecibidas esta retirada.");
}

export function AsientosContables_beforeInsert() {
    fiscalError(
        "AsientosContables esta retirada. Use el ledger aprobado."
    );
}
export function AsientosContables_beforeUpdate() {
    fiscalError("AsientosContables esta retirada.");
}
export function AsientosContables_beforeRemove() {
    fiscalError("AsientosContables esta retirada.");
}

export function ConfiguracionFiscal_beforeInsert() {
    fiscalError(
        "Use DatosFiscales con recordType CONFIG_SISTEMA."
    );
}
export function ConfiguracionFiscal_beforeUpdate() {
    fiscalError(
        "Use DatosFiscales con recordType CONFIG_SISTEMA."
    );
}
export function ConfiguracionFiscal_beforeRemove() {
    fiscalError(
        "Use DatosFiscales con recordType CONFIG_SISTEMA."
    );
}