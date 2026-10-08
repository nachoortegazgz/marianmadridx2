/*
=============================================================================
MODULE: backend/fiscalAggregator.web.js
VERSION: v5009-FISCAL-V20.1
BASE: v5002.2-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Resumenes fiscales trimestrales y extractos del ledger
 para reporting fiscal interno. Usa Stream Accumulator Pattern con
 paginacion acotada.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: import TIPO_MOVIMIENTO -> MOVEMENT_TYPE.
  - V20-02: lectura de campos de MovimientosCaja con nomenclatura V20.1
            (taxableBaseOrNonSubjectAmount, recordHash, linkedBookingIds,
            operationDescription, previousInvoiceId) + fallback legacy.
  - V20-03: lectura de DatosFiscales con nomenclatura V20.1
            (producerTaxId) + fallback legacy (businessTaxId, taxId,
            nifEmisor).
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "backend/dataAccess";

import {
  BUSINESS_COLLECTIONS,
  SDK_CONFIG,
  MOVEMENT_TYPE,
  RECORD_TYPE,
} from "backend/internalConfig";
import { makeTraceId, _safeTrim, _roundMoney, withTimeout } from "public/mmUtils";
import { requireCajero, requireAdmin, rateLimiter } from "backend/security";
import { logger } from "backend/logger";

import { _toPublicError } from "backend/responseUtils";

const log = logger;
const CHUNK_PAGE_SIZE = 100;
const MAX_PAGES = SDK_CONFIG?.JOBS?.FISCAL_DAILY_MAX_PAGES || 50;
const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;

// =============================================================================
// BLOQUE 0 - HELPERS DE LECTURA (V20.1 + fallback legacy)
// =============================================================================

function _readTaxableAmount(m) {
  // Canonical AEAT: baseImponibleOImporteNoSujeto (BIBLIA 11.4).
  if (m.baseImponibleOImporteNoSujeto !== undefined && m.baseImponibleOImporteNoSujeto !== null) {
    return Number(m.baseImponibleOImporteNoSujeto);
  }
  // Transitional read adapters, in preference order (EOL 31/12/2026).
  if (m.taxableBaseOrNonSubjectAmount !== undefined && m.taxableBaseOrNonSubjectAmount !== null) {
    return Number(m.taxableBaseOrNonSubjectAmount);
  }
  log.warn("legacy-read taxableAmount", { id: m?._id });
  return Number(m.taxableAmount ?? 0);
}

function _readTaxAmount(m) {
  // Canonical AEAT: cuotaTotal (BIBLIA 11.4).
  if (m.cuotaTotal !== undefined && m.cuotaTotal !== null) {
    return Number(m.cuotaTotal);
  }
  if (m.taxAmount !== undefined && m.taxAmount !== null) {
    log.warn("legacy-read taxAmount", { id: m?._id });
    return Number(m.taxAmount);
  }
  log.warn("legacy-read cuotaIva", { id: m?._id });
  return Number(m.cuotaIva ?? 0);
}

function _readTaxRate(m) {
  // Canonical AEAT: tipoImpositivo (BIBLIA 11.4). Neither taxRate nor tasaIva
  // is canonical; both are transitional read adapters only (EOL 31/12/2026).
  if (m.tipoImpositivo !== undefined && m.tipoImpositivo !== null) {
    return Number(m.tipoImpositivo);
  }
  if (m.taxRate !== undefined && m.taxRate !== null) {
    log.warn("legacy-read taxRate", { id: m?._id });
    return Number(m.taxRate);
  }
  log.warn("legacy-read tasaIva", { id: m?._id });
  return Number(m.tasaIva ?? 0);
}

function _readMovementType(m) {
  return _safeTrim(m.movementType ?? m.tipoMovimiento);
}

function _readOperationNature(m) {
  return _safeTrim(m.operationNature ?? m.naturalezaOperacion).toUpperCase();
}

function _readPaymentMethod(m) {
  return _safeTrim(m.paymentMethod ?? m.medioPago).toLowerCase();
}

function _readRecordHash(m) {
  // Canonical AEAT: recordHash + previousRecordHash chain (BIBLIA 11.4).
  const canonical = _safeTrim(m.recordHash);
  if (canonical) return canonical;
  if (m.currentRecordHash !== undefined && m.currentRecordHash !== null) {
    log.warn("legacy-read currentRecordHash", { id: m?._id });
    return _safeTrim(m.currentRecordHash);
  }
  log.warn("legacy-read hashCadena", { id: m?._id });
  return _safeTrim(m.hashCadena);
}

function _readLinkedBookingIds(m) {
  return _safeTrim(m.linkedBookingIds ?? m.reservaIdVinculada);
}

function _readInvoiceNumber(m) {
  return _safeTrim(m.invoiceNumber ?? m.numTicketFactura);
}

function _readOperationDate(m) {
  return _safeTrim(m.operationDate ?? m.diaKey);
}

function _readOperationDescription(m) {
  return _safeTrim(m.operationDescription ?? m.description ?? m.concepto);
}

function _readRecordSource(m) {
  return _safeTrim(m.recordSource ?? m.origen);
}

function _readPreviousInvoiceId(m) {
  return _safeTrim(m.previousInvoiceId ?? m.rectifiedInvoiceReference ?? m.referenciaRectificativa) || null;
}

// =============================================================================
// BLOQUE 1 - HELPERS
// =============================================================================

function _rateLimitOrThrow(surface, key, traceId) {
  const rl = rateLimiter({ surface, key });
  if (!rl.allowed) {
    const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
    e.code = "RATE_LIMITED";
    e.meta = { retryAfter: rl.retryAfter, surface, traceId };
    throw e;
  }
}

function _getQuarterMonths(year, quarter) {
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) return [];
  const monthMap = {
    1: ["01", "02", "03"],
    2: ["04", "05", "06"],
    3: ["07", "08", "09"],
    4: ["10", "11", "12"],
  };
  return monthMap[q].map((m) => `${y}-${m}`);
}

function _initTaxAccumulator(months) {
  const breakdownByMonth = {};
  months.forEach((m) => {
    breakdownByMonth[m] = { taxableAmount: 0, taxAmount: 0, total: 0, count: 0 };
  });
  return {
    totalTaxableAmount: 0,
    totalTaxAmount: 0,
    totalInvoiced: 0,
    totalGrossSales: 0,
    totalRefunds: 0,
    totalTips: 0,
    totalAdjustments: 0,
    countSales: 0,
    countRefunds: 0,
    countTips: 0,
    countAdjustments: 0,
    countFiscal: 0,
    totalOperations: 0,
    breakdownByPaymentMethod: { efectivo: 0, tarjeta: 0, bizum: 0, online: 0 },
    breakdownByMonth,
    breakdownByVatRate: {},
  };
}

function _accumulatePage(items, state) {
  for (const m of items) {
    state.totalOperations++;
    const accountingAmount = Number(m.accountingAmount || 0);
    const taxableAmount = _readTaxableAmount(m);
    const taxAmount = _readTaxAmount(m);
    const mes = _safeTrim(m.fiscalPeriod || m.mesKey);
    const paymentMethod = _readPaymentMethod(m);
    const taxRate = _readTaxRate(m);
    const taxRateKey = String(taxRate);
    const movementType = _readMovementType(m).toUpperCase();
    const operationNature = _readOperationNature(m) || (
      movementType === MOVEMENT_TYPE.PROPINA ? "PROPINA" :
      movementType === MOVEMENT_TYPE.REEMBOLSO || accountingAmount < 0 ? "DEVOLUCION" :
      movementType === MOVEMENT_TYPE.AJUSTE ? "AJUSTE" : "VENTA"
    );

    if (state.breakdownByPaymentMethod[paymentMethod] !== undefined) {
      state.breakdownByPaymentMethod[paymentMethod] += accountingAmount;
    }

    if (operationNature === "PROPINA") {
      state.totalTips += accountingAmount;
      state.countTips++;
      continue;
    }

    if (operationNature === "AJUSTE") {
      state.totalAdjustments += accountingAmount;
      state.countAdjustments++;
      continue;
    }

    state.countFiscal++;
    state.totalTaxableAmount += taxableAmount;
    state.totalTaxAmount += taxAmount;
    state.totalInvoiced += accountingAmount;

    if (operationNature === "VENTA") {
      state.totalGrossSales += accountingAmount;
      state.countSales++;
    } else {
      state.totalRefunds += accountingAmount;
      state.countRefunds++;
    }

    if (state.breakdownByMonth[mes]) {
      state.breakdownByMonth[mes].taxableAmount += taxableAmount;
      state.breakdownByMonth[mes].taxAmount += taxAmount;
      state.breakdownByMonth[mes].total += accountingAmount;
      state.breakdownByMonth[mes].count++;
    }

    if (!state.breakdownByVatRate[taxRateKey]) {
      state.breakdownByVatRate[taxRateKey] = { taxRate, taxableAmount: 0, taxAmount: 0, total: 0, operations: 0 };
    }
    state.breakdownByVatRate[taxRateKey].taxableAmount += taxableAmount;
    state.breakdownByVatRate[taxRateKey].taxAmount += taxAmount;
    state.breakdownByVatRate[taxRateKey].total += accountingAmount;
    state.breakdownByVatRate[taxRateKey].operations++;
  }
}

async function _fetchQuarterMovements(months, options = {}) {
  const { traceId = makeTraceId("fiscal-fetch"), limit = MAX_PAGES, pageSize = CHUNK_PAGE_SIZE } = options;
  let allItems = [];
  let query = wixData.query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
    .hasSome("fiscalPeriod", months)
    .ascending("sequenceNumber")
    .limit(pageSize);

  let res = await withTimeout(
    query.find({ suppressAuth: true, consistentRead: false }),
    CMS_TIMEOUT_MS,
    "fetchQuarterMovements:p1"
  );

  if (res?.items) allItems = allItems.concat(res.items);

  let page = 2;
  let reachedMaxPages = false;
  while (res && res.hasNext() && page <= limit) {
    res = await withTimeout(
      res.next({ suppressAuth: true, consistentRead: false }),
      CMS_TIMEOUT_MS,
      `fetchQuarterMovements:p${page}`
    );
    if (res?.items) allItems = allItems.concat(res.items);
    page++;
  }

  if (page > limit && res && res.hasNext()) {
    reachedMaxPages = true;
    log.warn("_fetchQuarterMovements: reached maxPages limit", { months, limit, traceId });
  }

  return { items: allItems, reachedMaxPages, totalPages: page - 1 };
}

// =============================================================================
// BLOQUE 2 - RESUMEN FISCAL TRIMESTRAL
// =============================================================================

export async function getQuarterlyTaxSummaryInternal(year, quarter, options = {}) {
  const traceId = options.traceId || makeTraceId("tax-summary");
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) {
    return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "year and quarter (1-4) are required." } };
  }

  const months = _getQuarterMonths(y, q);
  if (!months.length) {
    return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Could not resolve quarter months." } };
  }

  const fetchResult = await _fetchQuarterMovements(months, { traceId });
  const state = _initTaxAccumulator(months);
  _accumulatePage(fetchResult.items, state);

  // SSOT v20.1: un resumen fiscal no puede publicarse con un NIF ficticio.
  // El fallback legacy "BXXXXXXXX" queda ERRADICADO; si falta la configuracion
  // fiscal real, el agregador falla de forma explicita (FISCAL_CONFIG_MISSING).
  let nifEmisor;
  try {
    nifEmisor = await _getBusinessTaxId(traceId);
  } catch (err) {
    return {
      status: "ERROR",
      data: null,
      error: _toPublicError(err, "FISCAL_CONFIG_MISSING"),
    };
  }

  return {
    status: "SUCCESS",
    data: {
      ejercicio: y,
      trimestre: q,
      periodoMeses: months,
      nifEmisor,
      totalOperaciones: state.totalOperations,
      totalOperacionesFiscales: state.countFiscal,
      conteo: {
        ventas: state.countSales,
        reembolsos: state.countRefunds,
        propinas: state.countTips,
        ajustes: state.countAdjustments,
      },
      borradorIva: {
        estado: "REVISION_PROFESIONAL_REQUERIDA",
        baseImponibleRegistrada: _roundMoney(state.totalTaxableAmount),
        cuotaIvaRegistrada: _roundMoney(state.totalTaxAmount),
        nota: "No es un Modelo 303 oficial. Requiere validacion previa por gestoria.",
      },
      borradorIngresos: {
        estado: "REVISION_PROFESIONAL_REQUERIDA",
        ingresosRegistrados: _roundMoney(state.totalTaxableAmount),
        nota: "No es un Modelo 130 oficial. Requiere validacion previa por gestoria.",
      },
      totales: {
        totalVentasBrutas: _roundMoney(state.totalGrossSales),
        totalReembolsos: _roundMoney(state.totalRefunds),
        totalFacturadoNeto: _roundMoney(state.totalInvoiced),
        totalPropinasSeparadas: _roundMoney(state.totalTips),
        totalAjustesSeparados: _roundMoney(state.totalAdjustments),
      },
      desgloseFormaPago: {
        efectivo: _roundMoney(state.breakdownByPaymentMethod.efectivo),
        tarjeta: _roundMoney(state.breakdownByPaymentMethod.tarjeta),
        bizum: _roundMoney(state.breakdownByPaymentMethod.bizum),
        online: _roundMoney(state.breakdownByPaymentMethod.online),
      },
      desgloseMensual: Object.keys(state.breakdownByMonth).map((mesKey) => ({
        mesKey,
        baseImponible: _roundMoney(state.breakdownByMonth[mesKey].taxableAmount),
        cuotaIva: _roundMoney(state.breakdownByMonth[mesKey].taxAmount),
        total: _roundMoney(state.breakdownByMonth[mesKey].total),
        operaciones: state.breakdownByMonth[mesKey].count,
      })),
      desgloseTipoIva: Object.values(state.breakdownByVatRate).map((item) => ({
        tasaIva: item.taxRate,
        baseImponible: _roundMoney(item.taxableAmount),
        cuotaIva: _roundMoney(item.taxAmount),
        total: _roundMoney(item.total),
        operaciones: item.operations,
      })),
      reachedMaxPages: fetchResult.reachedMaxPages,
      totalPagesFetched: fetchResult.totalPages,
    },
    error: null,
  };
}

// =============================================================================
// BLOQUE 3 - LIBRO DE REGISTRO DE FACTURAS EXPEDIDAS
// =============================================================================

export async function getLibroRegistroFacturasExpedidasInternal(year, quarter, options = {}) {
  const traceId = options.traceId || makeTraceId("libro-registro");
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) {
    return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "year and quarter (1-4) are required." } };
  }

  const months = _getQuarterMonths(y, q);
  if (!months.length) {
    return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Could not resolve quarter months." } };
  }

  const fetchResult = await _fetchQuarterMovements(months, { traceId });
  let libroFilas = [];
  let orderIndex = 1;

  for (const m of fetchResult.items) {
    const accountingAmount = Number(m.accountingAmount || 0);
    const movementType = _readMovementType(m).toUpperCase();
    const operationNature = _readOperationNature(m);
    const isTip = operationNature === "PROPINA" || movementType === MOVEMENT_TYPE.PROPINA;
    const isAdjustment = operationNature === "AJUSTE" || movementType === MOVEMENT_TYPE.AJUSTE;
    const isRefund = operationNature === "DEVOLUCION" || movementType === MOVEMENT_TYPE.REEMBOLSO || accountingAmount < 0;
    const recordHash = _readRecordHash(m);

    libroFilas.push({
      orden: orderIndex++,
      invoiceNumber: _readInvoiceNumber(m),
      fechaExpedicion: _readOperationDate(m),
      tipoFactura: isRefund ? "R1" : "BORRADOR_INTERNO",
      movementType: _readMovementType(m),
      operationNature: operationNature || "VENTA",
      taxTreatment: _safeTrim(m.taxTreatment) || "PENDIENTE_VALIDACION",
      incluidoEnBorradorIva: !isTip && !isAdjustment,
      referenciaRectificativa: _readPreviousInvoiceId(m),
      paymentMethod: _safeTrim(m.paymentMethod ?? m.medioPago),
      taxableAmount: _roundMoney(_readTaxableAmount(m)),
      taxRate: `${Math.round(_readTaxRate(m) * 100)}%`,
      taxAmount: _roundMoney(_readTaxAmount(m)),
      totalAmount: _roundMoney(accountingAmount),
      concepto: _readOperationDescription(m),
      origen: _readRecordSource(m),
      orderId: _safeTrim(m.orderId) || null,
      refundId: _safeTrim(m.refundId) || null,
      fechaHoraRegistro: m.registeredAt || null,
      huellaSha256: recordHash.slice(0, 8).toUpperCase(),
      hashCompleto: recordHash,
      reservaVinculada: _readLinkedBookingIds(m) || null,
      transactionId: _safeTrim(m.transactionId),
    });
  }

  return {
    status: "SUCCESS",
    data: {
      ejercicio: y,
      trimestre: q,
      totalRegistros: libroFilas.length,
      filas: libroFilas,
      reachedMaxPages: fetchResult.reachedMaxPages,
      totalPagesFetched: fetchResult.totalPages,
    },
    error: null,
  };
}

async function _getBusinessTaxId(traceId) {
  // BIBLIA 10 / SSOT-09: ConfiguracionFiscal is FORBIDDEN. The emisor NIF lives
  // in DatosFiscales as the CONFIG_SISTEMA record. Canonical field per BIBLIA
  // 11.4 is nifProductor; the physical producer in eventLog writes taxId
  // (evidence: eventLog._upsertDatosFiscales), so taxId stays as a documented
  // read adapter until EOL 31/12/2026. No new write uses legacy fields.
  try {
    const byRecordType = await withTimeout(
      wixData.query(BUSINESS_COLLECTIONS.DATOS_FISCALES)
        .eq("recordType", RECORD_TYPE.CONFIG_SISTEMA)
        .eq("active", true)
        .limit(1)
        .find({ suppressAuth: true }),
      CMS_TIMEOUT_MS,
      "getBusinessTaxId"
    );
    let item = byRecordType?.items?.[0] || null;
    if (!item) {
      // Transitional read adapter (EOL 31/12/2026): current producer rows have
      // no recordType yet; fall back to the emisor marker when present.
      const legacy = await withTimeout(
        wixData.query(BUSINESS_COLLECTIONS.DATOS_FISCALES)
          .eq("thirdPartyType", "EMISOR")
          .eq("active", true)
          .limit(1)
          .find({ suppressAuth: true }),
        CMS_TIMEOUT_MS,
        "getBusinessTaxIdLegacyAdapter"
      );
      item = legacy?.items?.[0] || null;
      if (item) {
        log.warn("_getBusinessTaxId used legacy EMISOR adapter (no CONFIG_SISTEMA row)", { traceId });
      }
    }
    const canonical = _safeTrim(item?.producerTaxId || item?.nifProductor);
    if (canonical) return canonical;
    const transitional = _safeTrim(item?.taxId);
    if (transitional) {
      log.warn("_getBusinessTaxId read legacy taxId field; migrate to nifProductor before EOL", { traceId });
      return transitional.toUpperCase();
    }
    // SSOT v20.1: sin NIF real no se produce resumen fiscal valido.
    throw new Error("FISCAL_CONFIG_MISSING");
  } catch (err) {
    log.error("_getBusinessTaxId failed", { traceId, error: err?.message });
    throw err;
  }
}

// =============================================================================
// BLOQUE 4 - WEB METHODS
// =============================================================================

export const getQuarterlyTaxSummary = webMethod(Permissions.SiteMember, async (year, quarter, options = {}) => {
  const traceId = options.traceId || makeTraceId("tax-303");
  try {
    _rateLimitOrThrow("fiscal.getQuarterlyTaxSummary", "staff", traceId);
    await requireCajero(traceId);
    return await getQuarterlyTaxSummaryInternal(year, quarter, { ...options, traceId });
  } catch (err) {
    log.error("getQuarterlyTaxSummary failed", { error: err?.message, traceId });
    return { status: "ERROR", data: null, error: _toPublicError(err, "TAX_SUMMARY_FAIL") };
  }
});

export const getLibroRegistroFacturasExpedidas = webMethod(Permissions.Admin, async (year, quarter, options = {}) => {
  const traceId = options.traceId || makeTraceId("libro-registro");
  try {
    _rateLimitOrThrow("fiscal.getLibroRegistroFacturasExpedidas", "admin", traceId);
    await requireAdmin(traceId);
    return await getLibroRegistroFacturasExpedidasInternal(year, quarter, { ...options, traceId, rateLimitKey: "admin" });
  } catch (err) {
    log.error("getLibroRegistroFacturasExpedidas authorization failed", { error: err?.message, traceId });
    return { status: "ERROR", data: null, error: _toPublicError(err, "LIBRO_REGISTRO_FAIL") };
  }
});

// prepareScheduledManagerPackages REMOVED here (BIBLIA 17.6 dedupe).
// Canonical single implementation lives in backend/fiscalDocuments.web.

// =============================================================================
// FASE1-P0 TEST SURFACE (SSOT 23): read adapters and tax-id resolver are not
// exported by the production module. These thin internal wrappers expose them
// ONLY for the offline suite tests/fiscalAggregator.read.test.mjs. They add no
// behavior and no secrets. G10 ASCII strict.
// =============================================================================

export const __test__ = Object.freeze({
  readTaxableAmount: _readTaxableAmount,
  readTaxAmount: _readTaxAmount,
  readTaxRate: _readTaxRate,
  readRecordHash: _readRecordHash,
  getBusinessTaxId: _getBusinessTaxId,
});
