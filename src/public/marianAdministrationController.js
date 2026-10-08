/*
=============================================================================
MODULE: public/marianAdministrationController.js
VERSION: v5010.1-PUBLIC-ALIGN
BASE: v5007.3-FINAL + FASE2 (MAC-B01..B07) + frontend alignment pass
RESPONSIBILITY: Controlador del widget de administracion (HTML component).
  Traduce acciones MM_ADMIN_* a webMethods backend via el bridge canonico.
STANDARDS: G10 ASCII Strict, Velo V3 SDK. No importa modulos backend.

FIXES APLICADOS v5010.1-PUBLIC-ALIGN:
  - FIX-PUB-04 [CRITICO]: createWidgetBridge(widget, { messageType }) era
    incompatible con la API real del bridge (v5009 usa onMessage/onError y
    NO existe postMessage en el objeto devuelto -> TypeError en runtime).
    Reescrito sobre el contrato canonico:
      createWidgetBridge(widgetElement, { onMessage, onError, allowedTypes })
      bridge.send(type, payload, messageId)
  - FIX-PUB-05: Tipos dedicados MM_ADMIN_REQUEST (entrada) y
    MM_ADMIN_RESPONSE (salida), alineados con la whitelist SSOT del bridge
    (WB-B01). Ya no se reutiliza MM_CONTEXT como canal de respuestas.
  - FIX-PUB-06: GET_FISCAL_REPORT remapeado de generateLibroIVAExpedidas
    (prohibido por nomenclatura SSOT v5010.1: LIBROIVA*) a
    getLibroRegistroFacturasExpedidas (webMethod real exportado por
    fiscalAggregator.web.js linea 431, verificado; C-10/C-09).
  - FIX-PUB-07: Validadores _readYear/_readQuarter/_readEmail/_readDocumentId
    conservados; dispatch inmutable Object.freeze; guard null-safe payload.
=============================================================================
*/

import { createWidgetBridge } from "public/widgetBridge";

const ADMIN_ACTION_TYPES = Object.freeze({
  REQUEST: "MM_ADMIN",
  RESPONSE_INNER: "MM_ADMIN_RESPONSE",
});

// WB-B01 (SSOT whitelist): MM_ADMIN_REQUEST entra/ MM_ADMIN_RESPONSE sale.
const ADMIN_ALLOWED_TYPES = new Set(["MM_ADMIN_REQUEST"]);

function _sendResponse(bridge, messageId, body) {
  try {
    bridge.send("MM_ADMIN_RESPONSE", body, messageId);
  } catch (_) {
    // Bridge destruido: nada que reintentar en el front.
  }
}

function _postError(bridge, messageId, message, code) {
  _sendResponse(bridge, messageId, {
    type: ADMIN_ACTION_TYPES.RESPONSE_INNER,
    messageId,
    status: "ERROR",
    error: { code: code || "UNKNOWN", message: message || "Unknown error" },
  });
}

function _readYear(value) { const n = Number(value); if (!Number.isFinite(n) || n < 2020 || n > 2100) return null; return Math.floor(n); }
function _readQuarter(value) { const n = Number(value); if (!Number.isFinite(n) || n < 1 || n > 4) return null; return Math.floor(n); }
function _readEmail(value) { const s = String(value || "").trim().toLowerCase(); if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null; return s; }
function _readDocumentId(value) { const s = String(value || "").trim(); if (!s || s.length > 200) return null; return s; }
function _readPeriodParams(payload) { return { year: _readYear(payload?.year), quarter: _readQuarter(payload?.quarter), month: payload?.month ? Number(payload.month) : null }; }

const ADMIN_ACTION_DISPATCH = Object.freeze({
  GET_CASHIER_STATE: "getCashierState", REGISTER_MANUAL_TX: "registerManualTransaction",
  REGISTER_X_COUNT: "registerXCount", REGISTER_Z_CLOSING: "registerZClosing",
  VERIFY_HASH_CHAIN: "verifyFiscalHashChainIntegrity", GET_INVENTORY_DASHBOARD: "getInventoryDashboard",
  GET_RECONCILIATION_QUEUE: "getInventoryReconciliationQueue", GET_STAFF_CONTEXT: "getMyStaffContext",
  REGISTER_FICHAJE: "registrarFichaje", GET_JORNADA_STATE: "getEstadoJornada",
  CHECK_ADMIN_ACCESS: "checkAdminAccess", CHECK_CAJERO_ACCESS: "checkCajeroAccess",
  GET_FISCAL_REPORT: "getLibroRegistroFacturasExpedidas", GET_Z_CLOSING_REPORT: "generateCierreZReport",
});

/**
 * Inicializa el puente widget <-> pagina ADMINISTRACION.
 * @param {object} widget Elemento HTML Component de Velo (onMessage/postMessage).
 * @param {string} slug Slug de la pagina (trazabilidad).
 * @returns {{bridge: object, destroy: function}}
 */
export function initMarianAdministration(widget, slug) {
  if (!widget) throw new Error("initMarianAdministration: widget is required");

  const bridge = createWidgetBridge(widget, {
    allowedTypes: ADMIN_ALLOWED_TYPES,
    onMessage: (message) => {
      const payload = message?.payload || {};
      const action = payload.action;
      const messageId = message?.messageId || `msg_${Date.now()}`;

      if (message?.type !== "MM_ADMIN_REQUEST" || !action || !ADMIN_ACTION_DISPATCH[action]) {
        _postError(bridge, messageId, `Unknown action: ${String(action).slice(0, 40)}`, "UNKNOWN_ACTION");
        return;
      }

      try {
        _sendResponse(bridge, messageId, {
          type: ADMIN_ACTION_TYPES.RESPONSE_INNER,
          messageId,
          status: "DISPATCHED",
          action,
          targetMethod: ADMIN_ACTION_DISPATCH[action],
          params: payload.params || {},
          pageSlug: String(slug || ""),
        });
      } catch (err) {
        _postError(bridge, messageId, err?.message || "Dispatch failed", "DISPATCH_FAIL");
      }
    },
    onError: (err, data) => { console.error("[MarianAdministration] Error:", err?.code || err, data); },
  });

  return { bridge, destroy: () => bridge.destroy() };
}

export { _readYear, _readQuarter, _readEmail, _readDocumentId, _readPeriodParams, ADMIN_ACTION_DISPATCH };
