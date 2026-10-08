/*
=============================================================================
MODULE: backend/fiscalDocuments.web.js
VERSION: v5009-FISCAL-V20.1-REFACTORED
RESPONSIBILITY: Fiscal package preview, versioning, download and email dispatch.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "backend/dataAccess";
import { secrets } from "@wix/secrets";

import {
  BUSINESS_COLLECTIONS,
  SDK_CONFIG,
} from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { makeTraceId, _safeTrim, withTimeout, _roundMoney } from "public/mmUtils";
import { requireMarianManager } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import {
  getQuarterlyTaxSummary,
  getLibroRegistroFacturasExpedidasInternal,
} from "backend/fiscalAggregator.web.js";

const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
const DOCS_COL = BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z;
const MAX_EMAIL_ATTACHMENT_BYTES = Number(
  SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_ATTACHMENT_BYTES || 3145728
);
const MAX_EMAIL_SEND_ATTEMPTS = Number(
  SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_SEND_ATTEMPTS || 3
);
const DEFAULT_MANAGER_EMAIL =
  SDK_CONFIG?.DOCUMENTS?.DEFAULT_MANAGER_EMAIL || "gestion@marianmadrid.es";

function _validatePeriod(period = {}) {
  const year = Number(period.year);
  const quarter = Number(period.quarter);

  if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return null;
  }

  return { year, quarter };
}

function _formatDocumentId(year, quarter, version = 1) {
  return `DOC_GESTORIA_${year}_T${quarter}_PAQUETE_GESTORIA_V${String(version).padStart(4, "0")}`;
}

function _readInvoiceValue(invoice, canonical, ...legacyFields) {
  for (const field of [canonical, ...legacyFields]) {
    if (invoice?.[field] !== undefined && invoice?.[field] !== null) {
      return invoice[field];
    }
  }
  return "";
}

function _buildCsvFromInvoices(invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) {
    return "";
  }

  const header = "Numero;Fecha;Tipo;Base;Cuota;Total;FormaPago;Hash\n";
  const rows = invoices.map((invoice) => {
    const invoiceNumber = _readInvoiceValue(invoice, "invoiceNumber", "numTicketFactura");
    const issueDate = _readInvoiceValue(invoice, "issueDate", "fechaExpedicion", "diaKey");
    const movementType = _readInvoiceValue(invoice, "movementType", "tipoMovimiento");
    const taxableAmount = Number(_readInvoiceValue(invoice, "taxableAmount", "baseImponible") || 0);
    const taxAmount = Number(_readInvoiceValue(invoice, "taxAmount", "cuotaIva") || 0);
    const totalAmount = Number(invoice?.totalAmount || 0);
    const paymentMethod = _readInvoiceValue(invoice, "paymentMethod", "formaPago");
    const recordHash = _readInvoiceValue(invoice, "hashCompleto", "recordHash", "currentRecordHash", "hashCadena");

    return [
      invoiceNumber,
      issueDate,
      movementType,
      _roundMoney(taxableAmount),
      _roundMoney(taxAmount),
      _roundMoney(totalAmount),
      paymentMethod,
      recordHash,
    ].map((value) => `"${_safeTrim(value)}"`).join(";");
  });

  return `${header}${rows.join("\n")}`;
}

function _buildSummaryText(summary) {
  if (!summary) {
    return "Sin datos de resumen.";
  }

  const lines = [
    `Ejercicio: ${summary.ejercicio || "N/A"}`,
    `Trimestre: ${summary.trimestre || "N/A"}`,
    `Total Operaciones: ${summary.totalOperaciones || 0}`,
    `Total Operaciones Fiscales: ${summary.totalOperacionesFiscales || 0}`,
  ];

  if (summary.totales) {
    lines.push(`Total Ventas Brutas: ${_roundMoney(summary.totales.totalVentasBrutas || 0)} EUR`);
    lines.push(`Total Reembolsos: ${_roundMoney(summary.totales.totalReembolsos || 0)} EUR`);
    lines.push(`Total Facturado Neto: ${_roundMoney(summary.totales.totalFacturadoNeto || 0)} EUR`);
  }

  if (summary.borradorIva) {
    lines.push(`Borrador IVA - Base Imponible: ${_roundMoney(summary.borradorIva.baseImponibleRegistrada || 0)} EUR`);
    lines.push(`Borrador IVA - Cuota IVA: ${_roundMoney(summary.borradorIva.cuotaIvaRegistrada || 0)} EUR`);
  }

  return lines.join("\n");
}

async function _readPackageHistory(year, quarter) {
  let query = wixData.query(DOCS_COL).eq("closingType", "PAQUETE_GESTORIA");

  if (Number.isInteger(year)) {
    query = query.eq("fiscalYear", year);
  }

  if (Number.isInteger(quarter) && quarter >= 1 && quarter <= 4) {
    query = query.startsWith("inventoryClosingId", `DOC_GESTORIA_${year}_T${quarter}`);
  }

  const result = await withTimeout(
    query.descending("_createdDate").limit(50).find({ suppressAuth: true }),
    CMS_TIMEOUT_MS,
    "docHistory"
  );

  return result?.items || [];
}

export const previewManagerPackage = webMethod(
  Permissions.SiteMember,
  async (period = {}) => {
    const traceId = makeTraceId("doc-preview");

    try {
      await requireMarianManager(traceId);
      const validPeriod = _validatePeriod(period);

      if (!validPeriod) {
        return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
      }

      const [summaryResult, bookResult] = await Promise.all([
        getQuarterlyTaxSummary(validPeriod.year, validPeriod.quarter, { traceId }),
        getLibroRegistroFacturasExpedidasInternal(validPeriod.year, validPeriod.quarter, { traceId }),
      ]);

      const invoices = bookResult?.data?.filas || [];

      return {
        status: "SUCCESS",
        data: {
          period: validPeriod,
          documentIdDraft: _formatDocumentId(validPeriod.year, validPeriod.quarter),
          summary: summaryResult?.data || null,
          invoiceCount: invoices.length,
          previewGeneratedAt: new Date(),
        },
        error: null,
      };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_PREVIEW_FAIL") };
    }
  }
);

export const createManagerPackageVersion = webMethod(
  Permissions.SiteMember,
  async (period = {}) => {
    const traceId = makeTraceId("doc-create");

    try {
      await requireMarianManager(traceId);
      const validPeriod = _validatePeriod(period);

      if (!validPeriod) {
        return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
      }

      const history = await _readPackageHistory(validPeriod.year, validPeriod.quarter);
      const version = history.length + 1;
      const documentId = _formatDocumentId(validPeriod.year, validPeriod.quarter, version);
      const [summaryResult, bookResult] = await Promise.all([
        getQuarterlyTaxSummary(validPeriod.year, validPeriod.quarter, { traceId }),
        getLibroRegistroFacturasExpedidasInternal(validPeriod.year, validPeriod.quarter, { traceId }),
      ]);
      const createdAt = new Date();
      const record = {
        _id: documentId,
        inventoryClosingId: documentId,
        fiscalYear: validPeriod.year,
        closingDate: createdAt,
        closingType: "PAQUETE_GESTORIA",
        summaryData: summaryResult?.data || {},
        invoiceData: bookResult?.data?.filas || [],
        status: "PREPARED",
        traceId,
        _createdDate: createdAt,
      };

      await withTimeout(
        wixData.save(DOCS_COL, record, { suppressAuth: true }),
        CMS_TIMEOUT_MS,
        "saveManagerPackage"
      );

      return { status: "SUCCESS", data: { documentId, version, createdAt }, error: null };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_CREATE_FAIL") };
    }
  }
);

export const getManagerPackageHistory = webMethod(
  Permissions.SiteMember,
  async (period = {}) => {
    const traceId = makeTraceId("doc-history");

    try {
      await requireMarianManager(traceId);
      const year = Number(period.year);
      const quarter = Number(period.quarter);
      const items = await _readPackageHistory(
        Number.isInteger(year) ? year : null,
        Number.isInteger(quarter) ? quarter : null
      );

      return { status: "SUCCESS", data: items, error: null };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_HIST_FAIL") };
    }
  }
);

export const getPreparedManagerPackages = webMethod(
  Permissions.SiteMember,
  async () => {
    const traceId = makeTraceId("doc-prep");

    try {
      await requireMarianManager(traceId);
      const result = await withTimeout(
        wixData.query(DOCS_COL)
          .eq("closingType", "PAQUETE_GESTORIA")
          .descending("_createdDate")
          .limit(20)
          .find({ suppressAuth: true }),
        CMS_TIMEOUT_MS,
        "preparedPackages"
      );

      return { status: "SUCCESS", data: { items: result?.items || [] }, error: null };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_PREP_FAIL") };
    }
  }
);

export const downloadManagerPackageVersion = webMethod(
  Permissions.SiteMember,
  async (params = {}) => {
    const traceId = makeTraceId("doc-download");

    try {
      await requireMarianManager(traceId);
      const documentId = _safeTrim(params.documentId);

      if (!documentId) {
        return { status: "ERROR", data: null, error: { code: "DOC_ID_REQUIRED", message: "documentId required" } };
      }

      const document = await withTimeout(
        wixData.get(DOCS_COL, documentId, { suppressAuth: true }),
        CMS_TIMEOUT_MS,
        "getDocPackage"
      );

      if (!document) {
        return { status: "ERROR", data: null, error: { code: "DOC_NOT_FOUND", message: "Document version not found" } };
      }

      const invoices = Array.isArray(document.invoiceData) ? document.invoiceData : [];
      return {
        status: "SUCCESS",
        data: {
          documentId,
          csvContent: _buildCsvFromInvoices(invoices),
          summaryText: _buildSummaryText(document.summaryData),
          summary: document.summaryData || {},
          invoiceCount: invoices.length,
          createdAt: document._createdDate || document.closingDate,
        },
        error: null,
      };
    } catch (error) {
      return { status: "ERROR", data: null, error: _toPublicError(error, "DOC_DOWNLOAD_FAIL") };
    }
  }
);

export async function prepareScheduledManagerPackages(options = {}) {
  const traceId = options.traceId || makeTraceId("cron-packages");

  try {
    const now = new Date();
    const quarter = Math.floor(now.getMonth() / 3) + 1;
    const result = await createManagerPackageVersion({
      year: now.getFullYear(),
      quarter,
    });

    return { status: "SUCCESS", data: result?.data || null, error: null };
  } catch (error) {
    return { status: "ERROR", data: null, error: _toPublicError(error, "SCHEDULED_PACKAGES_FAIL") };
  }
}

// Email dispatch intentionally omitted from this refactor because Buffer is not
// available in Wix Velo. Use a supported attachment/base64 implementation before
// re-enabling outbound email delivery.
