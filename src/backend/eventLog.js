/*
=============================================================================
MODULE: backend/eventLog.js
VERSION: v5009-FISCAL-V20.1
BASE: v5009-FISCAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Motor atomico de registro fiscal (append-only) + proyector
                secundario + API fiscal completa (ventas, compras, consultas).
STANDARDS: G10 ASCII Strict.

REGLA V20.1: todos los IDs de campo CMS en ingles camelCase. Los nombres
AEAT oficiales dentro de fiscalPayload/computerSystem se preservan en
espanol porque son obligacion normativa.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: renames de campos en inserts y queries (DatosFiscales,
            MovimientosCaja, LibroAsientosContablesDetalle,
            FacturasRecibidas, HistoricoCierresZ).
  - V20-02: imports de constantes alineados a internalConfig V20.1.
  - V20-03: anadidos campos faltantes en la matriz pero usados por el
            codigo: fiscalRole, linkedAdvanceId, vatAccrualStatus,
            bankReconciliationReference, isB2B, issuerInvoiceNumber.
  - V20-04: constantes internas CAJA_ACTUAL_ID/CAJA_SEQ_ID renombradas
            a CASH_REGISTER_ID/CASH_SEQ_ID.

FIXES APLICADOS v5009-FISCAL (heredados):
  - FIX-EV-01..08.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,

    SINGLETONS,
    SDK_CONFIG,
    MOVEMENT_TYPE,
    PAYMENT_METHOD,
    IVA_RATES,
    CONCURRENCY,
    TIPO_FACTURA,
    CORRECTION_REASON,
    VAT_ACCRUAL_STATUS,
    FISCAL_ROLE,
    EVENT_TYPE,
    THIRD_PARTY_TYPE,
    PROJECTION_STATUS,
    COMPUTER_SYSTEM,
} from "backend/internalConfig";

import {
    hashSHA256,
    hashChain,
} from "backend/securityEngine";

import {
    makeTraceId,
    _safeTrim,
    _cleanText,
    _looksLikeGuid,
    _roundMoney,
    withTimeout,
} from "public/mmUtils";

import {
    _lockSlotKeyOrFail,
    _unlockSlotKey,
} from "backend/booking/bookingCore";

import { logger } from "backend/logger";

const log = logger;

// ============================================================================
// CONSTANTES
// ============================================================================

const CASH_REGISTER_ID = SINGLETONS?.CAJA || "CAJA_PRINCIPAL";
const CASH_SEQ_ID = "CAJA_SEQ";
const LEDGER_SCHEMA_VERSION = "LEDGER_V5_FISCAL";
const GENESIS_HASH = "0".repeat(64);

const SEQUENCE_MUTEX_KEY = "FISCAL_SEQUENCE_LOCK";
const SEQUENCE_MUTEX_TTL_MS = Number(CONCURRENCY?.LEDGER_MUTEX_TTL_MS) || 45000;

const PROYECCION_BATCH_LIMIT = 25;
const PROYECCION_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const FACTURA_PAYMENT_STATUSES = Object.freeze(["PENDIENTE", "PAGADO", "PARCIAL"]);

// ============================================================================
// SECCION 1 - HELPERS DE FECHA / AEAT
// ============================================================================

function _formatAEATDate(ymd) {
    const clean = _safeTrim(ymd);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
    if (!match) return clean;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function _formatAEATDateTimeMadrid(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const madridOffset = (() => {
        const madridStr = dt.toLocaleString("en-US", {
            timeZone: "Europe/Madrid",
            timeZoneName: "longOffset",
        });
        const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(madridStr);
        if (m) return `${m[1]}${m[2]}:${m[3]}`;
        const localMadrid = new Date(dt.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
        const diffMinutes = Math.round((localMadrid - dt) / 60000);
        const sign = diffMinutes >= 0 ? "+" : "-";
        const abs = Math.abs(diffMinutes);
        return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    })();

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${madridOffset}`;
}

function _buildGenerationTimestamp(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

// [V20.1] La funcion sigue generando el MISMO string AEAT key=value&...
// Solo se renombran las variables internas. El contenido de la cadena es
// identico al de v5009 para preservar la integridad SHA-256 existente.
function _buildAEATPayload(movement, generatedAt) {
    const recipientTaxId = _safeTrim(movement.recipientTaxId);
    const recipientLegalName = _safeTrim(movement.recipientLegalName);
    const invoiceNumber = _safeTrim(movement.invoiceNumber);
    const invoiceIssueDate = _safeTrim(movement.invoiceIssueDate);
    const invoiceType = _safeTrim(movement.invoiceType) || TIPO_FACTURA.F1;
    const taxAmount = Number(movement.taxAmount ?? 0);
    const totalAmount = Number(movement.totalAmount ?? 0);
    const previousRecordHash = _safeTrim(movement.previousRecordHash);
    const issuerTaxId = _safeTrim(movement.issuerTaxId);
    const correctionType = _safeTrim(movement.correctionType);
    const previousInvoiceId = _safeTrim(movement.previousInvoiceId);
    const correctionReason = _safeTrim(movement.correctionReason);
    const vatAccrualStatus = _safeTrim(movement.vatAccrualStatus);
    const linkedAdvanceId = _safeTrim(movement.linkedAdvanceId);
    const irpfWithholdingAmount = Number(movement.irpfWithholdingAmount || 0);
    const withholdingBase = Number(movement.withholdingBase || 0);
    const fiscalRole = _safeTrim(movement.fiscalRole);
    const surchargeAmount = Number(movement.surchargeAmount ?? 0);
    const bankReconciliationReference = _safeTrim(movement.bankReconciliationReference);

    const fields = [
        ["IDEmisorFactura", issuerTaxId || ""],
        ["NumSerieFactura", invoiceNumber || ""],
        ["FechaExpedicionFactura", _formatAEATDate(invoiceIssueDate)],
        ["TipoFactura", invoiceType],
        ["CuotaTotal", String(taxAmount.toFixed(2))],
        ["ImporteTotal", String(totalAmount.toFixed(2))],
        ["Huella", previousRecordHash || ""],
        ["FechaHoraHusoGenRegistro", _formatAEATDateTimeMadrid(generatedAt)],
    ];

    if (recipientTaxId) fields.push(["NIFDestinatario", recipientTaxId.slice(0, 20)]);
    if (recipientLegalName) fields.push(["NombreRazonDestinatario", recipientLegalName.slice(0, 200)]);
    if (bankReconciliationReference) fields.push(["ReferenciaBancaria", bankReconciliationReference.slice(0, 60)]);

    if (vatAccrualStatus === VAT_ACCRUAL_STATUS.APLICACION_ANTICIPO) {
        fields.push(["TipoRectificativa", "I"]);
        if (linkedAdvanceId) fields.push(["IdAnticipoVinculado", linkedAdvanceId.slice(0, 120)]);
    }

    if (correctionType) fields.push(["TipoRectificativa", correctionType.slice(0, 4)]);
    if (irpfWithholdingAmount > 0) {
        fields.push(["ImporteRetencionIRPF", String(irpfWithholdingAmount.toFixed(2))]);
        if (withholdingBase > 0) fields.push(["BaseImponibleRetencion", String(withholdingBase.toFixed(2))]);
        if (fiscalRole) fields.push(["RolFiscal", fiscalRole.slice(0, 10)]);
    }

    if (surchargeAmount > 0) fields.push(["ImporteRecargoEquivalencia", String(surchargeAmount.toFixed(2))]);
    if (correctionReason) fields.push(["MotivoRectificacion", correctionReason.slice(0, 4)]);
    if (previousInvoiceId) fields.push(["IdFacturaRectificada", previousInvoiceId.slice(0, 120)]);

    return fields.map(([k, v]) => `${k}=${v}`).join("&");
}

// ============================================================================
// SECCION 2 - SECUENCIA GLOBAL Y ULTIMO EVENTO
// ============================================================================

export async function _getNextSequenceInternal(traceId) {
    const lockOwnerId = `seq_${traceId || makeTraceId("seq")}`;

    const lockResult = await _lockSlotKeyOrFail(
        SEQUENCE_MUTEX_KEY,
        lockOwnerId,
        SEQUENCE_MUTEX_TTL_MS
    );
    if (!lockResult?.ok) {
        throw new Error("SEQUENCE_LOCK_BUSY: No se pudo adquirir el lock de secuencia");
    }

    try {
        let seqDoc = await wixData
            .get(BUSINESS_COLLECTIONS.CAJA_ACTUAL, CASH_SEQ_ID, { suppressAuth: true, consistentRead: true })
            .catch(() => null);

        if (!seqDoc) {
            const legacyCashRegister = await wixData
                .get(BUSINESS_COLLECTIONS.CAJA_ACTUAL, CASH_REGISTER_ID, { suppressAuth: true, consistentRead: true })
                .catch(() => null);

            const legacyCounters =
                legacyCashRegister && legacyCashRegister.sequenceCounters
                    ? legacyCashRegister.sequenceCounters
                    : { seqGlobal: 0 };

            seqDoc = {
                _id: CASH_SEQ_ID,
                sequenceCounters: { ...legacyCounters },
                migratedFrom: CASH_REGISTER_ID,
                migratedAt: new Date(),
                _createdDate: new Date(),
                _updatedDate: new Date(),
            };

            await wixData
                .insert(BUSINESS_COLLECTIONS.CAJA_ACTUAL, seqDoc, { suppressAuth: true })
                .catch(async (insertErr) => {
                    const msg = String(insertErr?.message || "");
                    if (msg.includes("WDE0123") || msg.includes("WD_ITEM_ALREADY_EXISTS") || msg.includes("Duplicated")) {
                        seqDoc = await wixData
                            .get(BUSINESS_COLLECTIONS.CAJA_ACTUAL, CASH_SEQ_ID, { suppressAuth: true, consistentRead: true })
                            .catch(() => null);
                        if (!seqDoc) throw insertErr;
                    } else {
                        throw insertErr;
                    }
                });
        }

        const counters = seqDoc.sequenceCounters || {};
        const nextGlobal = Number(counters.seqGlobal || 0) + 1;
        const yearKey = String(new Date().getFullYear());
        const nextYear = Number(counters[yearKey] || 0) + 1;
        counters.seqGlobal = nextGlobal;
        counters[yearKey] = nextYear;
        seqDoc.sequenceCounters = counters;
        seqDoc._updatedDate = new Date();

        await wixData.save(BUSINESS_COLLECTIONS.CAJA_ACTUAL, seqDoc, { suppressAuth: true });

        return {
            sequenceNumber: nextGlobal,
            yearSequence: nextYear,
            invoiceNumber: `FAC-${yearKey}-${String(nextYear).padStart(5, "0")}`,
        };
    } finally {
        await _unlockSlotKey(SEQUENCE_MUTEX_KEY, lockOwnerId).catch(() => {});
    }
}

async function _getLastCashEvent() {
    const res = await wixData
        .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
        .descending("sequenceNumber")
        .limit(1)
        .find({ suppressAuth: true, consistentRead: true });
    return res?.items?.[0] || null;
}

// ============================================================================
// SECCION 3 - MAESTROS
// ============================================================================

async function _upsertDatosFiscales({ taxId, legalName, thirdPartyType, contactData }, traceId) {
    const normalizedTaxId = _safeTrim(taxId).toUpperCase();
    if (!normalizedTaxId) return null;

    const existing = await wixData
        .query(BUSINESS_COLLECTIONS.DATOS_FISCALES)
        .eq("taxId", normalizedTaxId)
        .limit(1)
        .find({ suppressAuth: true });

    if (existing?.items?.[0]) return existing.items[0];

    return await wixData.insert(BUSINESS_COLLECTIONS.DATOS_FISCALES, {
        taxId: normalizedTaxId,
        legalName: _safeTrim(legalName).toUpperCase() || "SIN NOMBRE",
        thirdPartyType: thirdPartyType || THIRD_PARTY_TYPE.CLIENTE,
        contactData: contactData || null,
        active: true,
        registrationTraceId: traceId,
        _createdDate: new Date(),
        _updatedDate: new Date(),
    }, { suppressAuth: true });
}

async function _getServicioCatalogo(catalogId, traceId) {
    const id = _safeTrim(catalogId);
    if (!_looksLikeGuid(id)) return null;
    try {
        return await wixData.get(BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO, id, { suppressAuth: true });
    } catch (_) {
        log.warn("Catalogo no encontrado", { traceId, catalogId: id });
        return null;
    }
}

// ============================================================================
// SECCION 4 - PAYLOAD FISCAL (snapshot inmutable guardado en el doc)
// ============================================================================

// [V20.1] Los nombres de campos AEAT DENTRO del snapshot se preservan en
// espanol por obligacion normativa. Solo cambia el nombre del campo CMS
// (payloadFiscal -> fiscalPayload).
function _buildFiscalPayloadSnapshot({
    thirdParty, catalog, input, ts, previousRecordHash, recordHash, recordTimestamp,
}) {
    return {
        // --- Bloque AEAT (nombres oficiales en espanol) ---
        idEmisorFactura: _safeTrim(input.issuerTaxId),
        nombreRazonEmisor: _safeTrim(input.issuerLegalName),
        nifDestinatario: _safeTrim(thirdParty?.taxId || input.recipientTaxId),
        nombreRazonDestinatario: _safeTrim(thirdParty?.legalName || input.recipientLegalName),
        domicilioDestinatario: thirdParty?.contactData || input.recipientAddress || null,
        emitidaPorTerceroODestinatario: _safeTrim(input.issuedByThirdPartyOrRecipient) || "E",
        nombreRazonTercero: _safeTrim(input.thirdPartyLegalName) || null,
        nifTerceroExpedidor: _safeTrim(input.issuerThirdPartyTaxId) || null,
        numSerieFactura: _safeTrim(input.invoiceNumber),
        fechaExpedicionFactura: _safeTrim(input.invoiceIssueDate),
        fechaOperacion: _safeTrim(input.operationDate) || null,
        tipoFactura: _safeTrim(input.invoiceType) || "F1",
        tipoRectificativa: _safeTrim(input.correctionType) || null,
        descripcionOperacion: _safeTrim(input.operationDescription),
        importeTotal: Number(input.totalAmount ?? 0),
        baseImponibleOImporteNoSujeto: Number(input.taxableBaseOrNonSubjectAmount ?? 0),
        cuotaTotal: Number(input.taxAmount ?? 0),
        tipoImpositivo: Number(input.taxRate ?? catalog?.taxRate ?? 0),
        tipoRecargoEquivalencia: Number(input.surchargeRate ?? 0),
        cuotaRecargoEquivalencia: Number(input.surchargeAmount ?? 0),
        importeRetencionIRPF: Number(input.irpfWithholdingAmount ?? 0),
        tipoRetencionIRPF: Number(input.irpfWithholdingRate ?? 0),
        baseImponibleRetencion: Number(input.withholdingBase ?? 0),
        claveRegimen: _safeTrim(input.regimeKey || catalog?.aeatRegimeKey) || "01",
        calificacionOperacion: _safeTrim(input.operationClassification || catalog?.aeatOperationClassification) || "S1",
        operacionExenta: _safeTrim(input.exemptOperation || catalog?.aeatExemptOperation) || null,
        inversionSujetoPasivo: input.reverseCharge === true || catalog?.reverseCharge === true,
        causaNoSujeta: _safeTrim(input.nonSubjectReason) || null,
        regimenEspecialCriterioCaja: input.cashBasisRegime === true,
        exentaPorArticulo20: input.article20Exempt === true,
        sistemaInformatico: { ...COMPUTER_SYSTEM },
        idFacturaAnterior: _safeTrim(input.previousInvoiceId) || null,
        numSerieFacturaAnterior: _safeTrim(input.previousInvoiceNumber) || null,
        fechaExpedicionFacturaAnterior: _safeTrim(input.previousInvoiceIssueDate) || null,
        huellaAnterior: previousRecordHash || null,
        huella: recordHash,
        fechaHoraHusoGenRegistro: recordTimestamp,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: Array.isArray(input.breakdown) ? input.breakdown : [],
    };
}

// ============================================================================
// SECCION 5 - MOTOR — registrarEventoEconomico
// ============================================================================

export async function registrarEventoEconomico(input) {
    const traceId = input.traceId || makeTraceId("evento");
    const ts = new Date();

    // 1. Resolver tercero
    const thirdParty = await _upsertDatosFiscales({
        taxId: input.recipientTaxId || input.issuerTaxId,
        legalName: input.recipientLegalName || input.issuerLegalName,
        thirdPartyType: input.thirdPartyType || THIRD_PARTY_TYPE.CLIENTE,
        contactData: input.contactData || input.recipientAddress || null,
    }, traceId);

    // 2. Resolver catalogo
    const catalog = await _getServicioCatalogo(input.catalogId, traceId);

    // 3. Ultimo evento + secuencia
    const previous = await _getLastCashEvent();
    const seq = await _getNextSequenceInternal(traceId);

    const previousRecordHash = _safeTrim(previous?.recordHash) || GENESIS_HASH;
    const recordTimestamp = _formatAEATDateTimeMadrid(ts);

    // 4. Construir movimiento base (aun sin huella)
    const baseMovement = {
        sequenceNumber: seq.sequenceNumber,
        invoiceNumber: _safeTrim(input.invoiceNumber) || seq.invoiceNumber,
        invoiceIssueDate: _safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }),
        operationDate: _safeTrim(input.operationDate) || null,
        fiscalPeriod: (_safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" })).slice(0, 7),

        movementType: _safeTrim(input.movementType),
        eventType: _safeTrim(input.eventType),
        paymentMethod: _safeTrim(input.paymentMethod),
        channelType: _safeTrim(input.channelType) || "POS",

        totalAmount: Number(input.totalAmount ?? 0),
        taxableBaseOrNonSubjectAmount: Number(input.taxableBaseOrNonSubjectAmount ?? 0),
        taxAmount: Number(input.taxAmount ?? 0),
        taxRate: Number(input.taxRate ?? IVA_RATES.GENERAL),
        surchargeRate: Number(input.surchargeRate ?? 0),
        surchargeAmount: Number(input.surchargeAmount ?? 0),
        irpfWithholdingAmount: Number(input.irpfWithholdingAmount ?? 0),
        irpfWithholdingRate: Number(input.irpfWithholdingRate ?? 0),
        withholdingBase: Number(input.withholdingBase ?? 0),
        fiscalRole: _safeTrim(input.fiscalRole) || FISCAL_ROLE.EMISOR,

        operationDescription: _cleanText(input.operationDescription || "", 500),

        invoiceType: _safeTrim(input.invoiceType) || TIPO_FACTURA.F1,
        correctionType: _safeTrim(input.correctionType) || null,
        correctionReason: _safeTrim(input.correctionReason) || null,
        previousInvoiceId: _safeTrim(input.previousInvoiceId) || null,
        previousInvoiceNumber: _safeTrim(input.previousInvoiceNumber) || null,
        previousInvoiceIssueDate: _safeTrim(input.previousInvoiceIssueDate) || null,
        issuerInvoiceNumber: _safeTrim(input.issuerInvoiceNumber) || null,
        correctionAmount: input.correctionAmount || null,

        issuerTaxId: _safeTrim(input.issuerTaxId),
        issuerLegalName: _safeTrim(input.issuerLegalName),
        recipientTaxId: _safeTrim(thirdParty?.taxId || input.recipientTaxId),
        recipientLegalName: _safeTrim(thirdParty?.legalName || input.recipientLegalName),
        recipientAddress: thirdParty?.contactData || input.recipientAddress || null,
        isB2B: input.isB2B === true,

        issuedByThirdPartyOrRecipient: _safeTrim(input.issuedByThirdPartyOrRecipient) || "E",
        thirdPartyLegalName: _safeTrim(input.thirdPartyLegalName) || null,
        issuerThirdPartyTaxId: _safeTrim(input.issuerThirdPartyTaxId) || null,
        nonSubjectReason: _safeTrim(input.nonSubjectReason) || null,
        reverseCharge: input.reverseCharge === true || catalog?.reverseCharge === true,

        regimeKey: _safeTrim(input.regimeKey || catalog?.aeatRegimeKey) || "01",
        operationClassification: _safeTrim(input.operationClassification || catalog?.aeatOperationClassification) || "S1",
        exemptOperation: _safeTrim(input.exemptOperation || catalog?.aeatExemptOperation) || null,
        cashBasisRegime: input.cashBasisRegime === true,
        article20Exempt: input.article20Exempt === true,

        linkedAdvanceId: _safeTrim(input.linkedAdvanceId) || null,
        vatAccrualStatus: _safeTrim(input.vatAccrualStatus) || VAT_ACCRUAL_STATUS.DEVENGADO,
        bankReconciliationReference: _safeTrim(input.bankReconciliationReference) || null,

        resourceId: _safeTrim(input.resourceId) || null,
        staffResourceId: _safeTrim(input.staffResourceId) || null,
        linkedBookingIds: _safeTrim(input.linkedBookingIds) || null,
        transactionId: _safeTrim(input.transactionId) || `TX_${seq.sequenceNumber}`,
        orderId: _safeTrim(input.orderId) || null,
        refundId: _safeTrim(input.refundId) || null,
        pairToken: _safeTrim(input.pairToken) || null,

        thirdPartyId: thirdParty?._id || null,
        catalogId: catalog?._id || null,

        schemaVersion: LEDGER_SCHEMA_VERSION,
        recordSource: _safeTrim(input.recordSource) || "INTERNAL",
        lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    };

    // 5. AEAT payload + huella (cadena SHA-256 preservada)
    const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, ts);
    const recordHash = await hashChain(previousRecordHash, aeatPayload);

    // 6. Snapshot inmutable (fiscalPayload con nombres AEAT dentro)
    const fiscalPayload = _buildFiscalPayloadSnapshot({
        thirdParty, catalog, input, ts,
        previousRecordHash, recordHash,
        recordTimestamp,
    });

    // 7. Doc cabecera
    const doc = {
        ...baseMovement,
        recordHash,
        previousRecordHash,
        recordTimestamp,
        generationTimestamp: _buildGenerationTimestamp(ts),
        detailedBreakdown: fiscalPayload.desgloseDetallado,
        computerSystem: fiscalPayload.sistemaInformatico,
        fiscalPayload,
        projectionStatus: PROJECTION_STATUS.PENDIENTE,
        projectionDetailIds: [],
        traceId,
        registeredAt: ts,
        _createdDate: new Date(),
    };

    const cabecera = await wixData.insert(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, doc, { suppressAuth: true });

    // 8. Detalle (lineas)
    const detailIds = [];
    const breakdown = Array.isArray(input.breakdown) ? input.breakdown : [];
    for (let i = 0; i < breakdown.length; i++) {
        const d = breakdown[i];
        const lineHash = await hashSHA256(recordHash + JSON.stringify(d));
        const det = await wixData.insert(BUSINESS_COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE, {
            lineHash,
            taxableBaseOrNonSubjectAmount: Number(d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0),
            taxRate: Number(d.taxRate ?? d.tipo ?? 0),
            chargedTaxAmount: Number(d.chargedTaxAmount ?? d.cuota ?? 0),
            sourceEventId: cabecera._id,
            lineNumber: i + 1,
            thirdPartyId: thirdParty?._id || null,
            catalogId: catalog?._id || null,
            operationDescription: _cleanText(d.operationDescription || input.operationDescription || "", 500),
            units: Number(d.units || 1),
            magnitude: Number(d.magnitude || 1),
            netUnitAmount: Number(d.netUnitAmount ?? 0),
            taxCode: _safeTrim(d.taxCode || catalog?.taxCode) || null,
            regimeKey: _safeTrim(d.regimeKey || fiscalPayload.claveRegimen),
            operationClassification: _safeTrim(d.operationClassification || fiscalPayload.calificacionOperacion),
            exemptOperation: _safeTrim(d.exemptOperation) || null,
            reverseCharge: d.reverseCharge === true || fiscalPayload.inversionSujetoPasivo,
            accountCode: _safeTrim(d.accountCode || catalog?.incomeAccountCode) || null,
            surchargeRate: Number(d.surchargeRate ?? 0),
            surchargeAmount: Number(d.surchargeAmount ?? 0),
            irpfWithholdingAmount: Number(d.irpfWithholdingAmount || 0),
            irpfWithholdingRate: Number(d.irpfWithholdingRate || 0),
            _createdDate: new Date(),
        }, { suppressAuth: true });
        detailIds.push(det._id);
    }

    // 9. Proyeccion secundaria — NUNCA propaga errores al caller
    let projectionStatus = PROJECTION_STATUS.OK;
    try {
        await _proyectarSegunTipoEvento(cabecera, detailIds, traceId);
    } catch (err) {
        projectionStatus = PROJECTION_STATUS.ERROR;
        log.error("Proyeccion secundaria fallo (no bloqueante)", {
            traceId,
            eventoId: cabecera._id,
            eventType: cabecera.eventType,
            message: err?.message,
        });
    }

    return {
        status: projectionStatus === PROJECTION_STATUS.OK ? "SUCCESS" : "PARTIAL",
        data: {
            cabeceraId: cabecera._id,
            detailIds,
            recordHash,
            sequenceNumber: seq.sequenceNumber,
            invoiceNumber: doc.invoiceNumber,
            projectionStatus,
        },
        error: null,
    };
}

// ============================================================================
// SECCION 6 - PROYECCION SECUNDARIA
// ============================================================================

async function _proyectarSegunTipoEvento(cabecera, detailIds, traceId) {
    switch (cabecera.eventType) {
        case EVENT_TYPE.VENTA_LINEA:
        case EVENT_TYPE.RECTIFICATIVA:
        case EVENT_TYPE.AJUSTE:
            await _proyectarAsientoContable(cabecera, traceId);
            break;
        case EVENT_TYPE.COMPRA_LINEA:
            await _proyectarFacturaRecibida(cabecera, traceId);
            break;
        case EVENT_TYPE.MOV_STOCK:
            await _proyectarMovimientoInventario(cabecera, traceId);
            break;
        case EVENT_TYPE.CIERRE_Z:
            await _proyectarCierreZ(cabecera, traceId);
            break;
        default:
            log.warn("Tipo evento sin proyeccion", { traceId, eventType: cabecera.eventType });
    }
}

async function _proyectarAsientoContable(cabecera, traceId) {
    try {
        const { projectLedgerMovementToAccounting } = await import("backend/contabilidad");
        const res = await projectLedgerMovementToAccounting(cabecera);
        // SKIPPED: proyeccion deliberadamente desactivada o sin mapa aprobado
        // (SDK_CONFIG.ACCOUNTING.ENABLED=false). No es un fallo de proyeccion.
        // PROJECTED: destino contable no verificado aun; se devuelve la
        // proyeccion firmada sin persistir (ver contabilidad.js). Tampoco es
        // un error y no debe lanzarse como tal.
        if (res?.status !== "SUCCESS" && res?.status !== "SKIPPED" && res?.status !== "PROJECTED") {
            throw new Error(`contabilidad.js: ${res?.status || "UNKNOWN"}`);
        }
    } catch (err) {
        log.warn("Proyeccion contable fallo", { traceId, eventoId: cabecera._id, message: err?.message });
        // SSOT v20.1 (FASE4): las lineas contables se escriben en
        // LibroAsientosContablesDetalle (recordType ACCOUNTING_LINE), que NO
        // es el ledger append-only MovimientosCaja. El hook
        // MovimientosCaja_beforeUpdate bloquearia cualquier update de estado
        // de proyeccion sobre la cabecera, por lo que no puede abrirse una
        // excepcion silenciosa al append-only. La trazabilidad alternativa es
        // esta marca de auditoria en el log para el reconciliador/manual.
        log.warn("PROJECTION_UNCONFIRMED", {
            traceId,
            sourceEventId: cabecera?._id || null,
            targetCollection:
                BUSINESS_COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE,
            recordType: "ACCOUNTING_LINE",
        });
        throw err;
    }
}

// FASE3 SSOT-09: FacturasRecibidas is a FORBIDDEN collection. The purchase
// invoice record IS the MovimientosCaja header itself (eventType COMPRA_LINEA,
// movementType PAGO_PROVEEDOR) with its AEAT fiscalPayload. Secondary
// projection removed; readers query the ledger directly.
async function _proyectarFacturaRecibida(cabecera, traceId) {
    return undefined;
}

async function _proyectarMovimientoInventario(cabecera, traceId) {
    try {
        const mod = await import("backend/inventario.web.js");
        const fn = mod?.recordInventoryMovementSafe;
        if (typeof fn !== "function") {
            log.warn("inventario.recordInventoryMovementSafe no disponible", { traceId });
            return;
        }
        await fn({
            wixProductId: cabecera.fiscalPayload?.wixProductId || null,
            sku: cabecera.fiscalPayload?.sku || null,
            orderId: cabecera.orderId || null,
            refundId: cabecera.fiscalPayload?.refundId || null,
            sourceEventId: cabecera._id,
            catalogId: cabecera.catalogId,
            magnitude: cabecera.fiscalPayload?.magnitude || 1,
            thirdPartyId: cabecera.thirdPartyId,
            traceId,
        });
    } catch (err) {
        log.warn("Proyeccion inventario fallo", { traceId, eventoId: cabecera._id, message: err?.message });
        throw err;
    }
}

async function _proyectarCierreZ(cabecera, traceId) {
    try {
        await wixData.insert(BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z, {
            _id: `Z_${cabecera.invoiceIssueDate}`,
            operationDate: cabecera.invoiceIssueDate,
            balancesByMethod: cabecera.fiscalPayload?.saldosPorMetodo || {},
            sourceEventId: cabecera._id,
            breakdownByRegime: cabecera.fiscalPayload?.desglosePorRegimen || [],
            breakdownByOperationType: cabecera.fiscalPayload?.desglosePorTipoOperacion || [],
            breakdownByTaxRate: cabecera.fiscalPayload?.desglosePorTipoImpositivo || [],
            verifactuSummary: cabecera.fiscalPayload?.resumenVerifactu || {},
            aeatSubmissionStatus: "PENDIENTE",
            traceId,
            _createdDate: new Date(),
        }, { suppressAuth: true });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("WDE0123") || msg.includes("Duplicated") || msg.includes("already exists")) {
            log.info("CierreZ ya existe (idempotente)", { traceId, fecha: cabecera.invoiceIssueDate });
            return;
        }
        throw err;
    }
}

// ============================================================================
// SECCION 7 - CONSULTAS DE EVENTOS
// ============================================================================

export const getEventoPorId = webMethod(
    Permissions.Admin,
    async (eventoId) => {
        const traceId = makeTraceId("get-evento");
        try {
            if (!_looksLikeGuid(eventoId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const evento = await wixData
                .get(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, eventoId, { suppressAuth: true })
                .catch(() => null);
            if (!evento) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            const detail = await wixData
                .query(BUSINESS_COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE)
                .eq("sourceEventId", eventoId)
                .ascending("lineNumber")
                .find({ suppressAuth: true });
            return {
                status: "SUCCESS",
                data: { cabecera: evento, detalle: detail.items || [] },
                error: null,
            };
        } catch (error) {
            log.error("getEventoPorId fallo", { traceId, message: error?.message });
            return { status: "ERROR", data: null, error: { code: "LOOKUP_FAILED" } };
        }
    }
);

// ============================================================================
// SECCION 8 - API DE COMPRAS (absorbe facturasRecibidas.web.js)
// ============================================================================

export const registrarFacturaRecibida = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("fact-rec");
        try {
            const issuerTaxId = _safeTrim(payload?.issuerTaxId).toUpperCase();
            if (!issuerTaxId) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "ISSUER_TAX_ID_REQUIRED", message: "issuerTaxId obligatorio" },
                };
            }
            const invoiceNumber = _safeTrim(payload?.invoiceNumber);
            if (!invoiceNumber) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "INVOICE_NUMBER_REQUIRED", message: "invoiceNumber obligatorio" },
                };
            }
            const totalAmount = Number(payload?.totalAmount) || 0;
            if (totalAmount <= 0) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "INVALID_AMOUNT", message: "totalAmount > 0" },
                };
            }

            // Idempotencia por invoiceNumber + issuerTaxId sobre el ledger
            const existing = await wixData
                .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("movementType", MOVEMENT_TYPE.PAGO_PROVEEDOR)
                .eq("invoiceNumber", invoiceNumber)
                .eq("thirdPartyTaxId", issuerTaxId)
                .limit(1)
                .find({ suppressAuth: true });
            if (existing?.items?.[0]) {
                return {
                    status: "SUCCESS",
                    data: existing.items[0],
                    error: null,
                    idempotent: true,
                };
            }

            const eventResult = await registrarEventoEconomico({
                eventType: EVENT_TYPE.COMPRA_LINEA,
                movementType: MOVEMENT_TYPE.PAGO_PROVEEDOR,
                paymentMethod: _safeTrim(payload?.paymentMethod) || PAYMENT_METHOD.EFECTIVO,
                totalAmount,
                taxableBaseOrNonSubjectAmount: Number(payload?.totalTaxableBase) || 0,
                taxAmount: Number(payload?.totalVatAmount) || 0,
                taxRate: Number(payload?.taxRate) || IVA_RATES.GENERAL,
                surchargeRate: Number(payload?.surchargeRate) || 0,
                surchargeAmount: Number(payload?.surchargeAmount) || 0,
                irpfWithholdingAmount: Number(payload?.irpfWithholdingAmount) || 0,
                irpfWithholdingRate: Number(payload?.irpfWithholdingRate) || 0,
                operationDescription: _cleanText(payload?.operationDescription || "", 500),
                invoiceNumber,
                invoiceIssueDate: _safeTrim(payload?.invoiceIssueDate),
                operationDate: _safeTrim(payload?.operationDate) || null,
                invoiceType: _safeTrim(payload?.invoiceType) || TIPO_FACTURA.F1,
                issuerTaxId,
                issuerLegalName: _safeTrim(payload?.issuerLegalName),
                recipientTaxId: _safeTrim(payload?.recipientTaxId),
                recipientLegalName: _safeTrim(payload?.recipientLegalName),
                regimeKey: _safeTrim(payload?.regimeKey) || "01",
                operationClassification: _safeTrim(payload?.operationClassification) || "S1",
                exemptOperation: _safeTrim(payload?.exemptOperation) || null,
                reverseCharge: payload?.reverseCharge === true,
                breakdown: Array.isArray(payload?.detailedBreakdown) ? payload.detailedBreakdown : [],
                traceId,
            });

            return eventResult;
        } catch (err) {
            log.error("registrarFacturaRecibida fallo", { traceId, message: err?.message });
            return {
                status: "ERROR", data: null,
                error: { code: "FACT_REC_FAIL", message: err?.message },
            };
        }
    }
);

export const getFacturaRecibida = webMethod(
    Permissions.Admin,
    async (facturaId) => {
        const traceId = makeTraceId("get-fact-rec");
        try {
            if (!_looksLikeGuid(facturaId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const factura = await wixData
                .get(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, facturaId, { suppressAuth: true })
                .catch(() => null);
            if (!factura || factura.movementType !== MOVEMENT_TYPE.PAGO_PROVEEDOR) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            return { status: "SUCCESS", data: factura, error: null };
        } catch (err) {
            log.error("getFacturaRecibida fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "LOOKUP_FAILED" } };
        }
    }
);

export const listarFacturasRecibidas = webMethod(
    Permissions.Admin,
    async (filters = {}) => {
        const traceId = makeTraceId("list-fact-rec");
        try {
            let q = wixData.query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("movementType", MOVEMENT_TYPE.PAGO_PROVEEDOR);
            if (filters?.paymentStatus) {
                q = q.eq("paymentStatus", _safeTrim(filters.paymentStatus).toUpperCase());
            }
            if (filters?.thirdPartyId && _looksLikeGuid(filters.thirdPartyId)) {
                q = q.eq("thirdPartyId", filters.thirdPartyId);
            }
            if (filters?.desde) {
                q = q.ge("invoiceIssueDate", filters.desde);
            }
            if (filters?.hasta) {
                q = q.le("invoiceIssueDate", filters.hasta);
            }
            const limit = Math.min(Number(filters?.limit) || 50, 200);
            const res = await q.descending("invoiceIssueDate").limit(limit)
                .find({ suppressAuth: true });
            return {
                status: "SUCCESS",
                data: { items: res.items || [], total: res.totalCount },
                error: null,
            };
        } catch (err) {
            log.error("listarFacturasRecibidas fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "QUERY_FAILED" } };
        }
    }
);

export const actualizarEstadoPagoFactura = webMethod(
    Permissions.SiteMember,
    async (facturaId, newStatus, meta = {}) => {
        const traceId = meta?.traceId || makeTraceId("upd-fact-rec");
        try {
            if (!_looksLikeGuid(facturaId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const factura = await wixData
                .get(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, facturaId, { suppressAuth: true })
                .catch(() => null);
            if (!factura || factura.movementType !== MOVEMENT_TYPE.PAGO_PROVEEDOR) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            const status = _safeTrim(newStatus).toUpperCase();
            if (!FACTURA_PAYMENT_STATUSES.includes(status)) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "INVALID_PAYMENT_STATUS", message: `paymentStatus debe ser ${FACTURA_PAYMENT_STATUSES.join("|")}` },
                };
            }
            await wixData.update(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, {
                _id: facturaId,
                paymentStatus: status,
                paymentDate: status === "PAGADO" ? new Date() : factura.paymentDate,
                paymentMethod: meta?.paymentMethod || factura.paymentMethod,
                _updatedDate: new Date(),
            }, { suppressAuth: true });
            return {
                status: "SUCCESS",
                data: { facturaId, paymentStatus: status },
                error: null,
            };
        } catch (err) {
            log.error("actualizarEstadoPagoFactura fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "UPDATE_FAILED" } };
        }
    }
);

// ============================================================================
// SECCION 9 - RECONCILIACION (cron)
// ============================================================================

export async function reconciliarProyecciones() {
    const traceId = makeTraceId("recon");
    let processed = 0;
    let failed = 0;
    try {
        const pending = await wixData
            .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
            .ne("projectionStatus", PROJECTION_STATUS.OK)
            .descending("sequenceNumber")
            .limit(PROYECCION_BATCH_LIMIT)
            .find({ suppressAuth: true });

        for (const evento of pending.items || []) {
            try {
                await withTimeout(
                    _proyectarSegunTipoEvento(evento, evento.projectionDetailIds || [], traceId),
                    PROYECCION_TIMEOUT_MS,
                    "reconciliarProyecciones"
                );
                processed += 1;
            } catch (err) {
                failed += 1;
                log.warn("Reconciliacion fallo", {
                    traceId,
                    eventoId: evento._id,
                    message: err?.message,
                });
            }
        }

        return {
            status: "SUCCESS",
            data: { processed, failed, total: pending.items?.length || 0 },
        };
    } catch (err) {
        log.error("reconciliarProyecciones fallo global", { traceId, message: err?.message });
        return {
            status: "ERROR",
            data: { processed, failed },
            error: { code: "RECON_FAIL", message: err?.message },
        };
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    registrarEventoEconomico,
    _getNextSequenceInternal,
    getEventoPorId,
    reconciliarProyecciones,
    registrarFacturaRecibida,
    getFacturaRecibida,
    listarFacturasRecibidas,
    actualizarEstadoPagoFactura,
};
