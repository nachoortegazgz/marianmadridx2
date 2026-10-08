/*
=============================================================================
MODULE: backend/audit.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FIX-D3 + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Registro centralizado de auditoria operativa.
STANDARDS: G10 ASCII Strict.
COLECCION DESTINO: ALERTAS_OPERATIVAS.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. Los campos que escribe
            (eventType, level, message, data, resourceId, source, traceId,
            loggedAt) son propios de auditoria y no forman parte de la
            matriz V20.1. ALERTAS_OPERATIVAS mantiene su schema.
=============================================================================
*/

import wixData from "backend/dataAccess";

import {
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    SDK_CONFIG,
} from "backend/internalConfig";

import {
    _cloneDeep,
    _cleanText,
    _normalizeIdPart,
    _safeTrim,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

const API_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

const DEFAULT_ENTITY_ID = "system";
const DEFAULT_SOURCE = "backend/audit.js";

const VALID_LEVELS = new Set([
    "INFO",
    "WARNING",
    "ERROR",
    "CRITICAL",
]);

// =============================================================================
// HELPERS
// =============================================================================

function _normalizeLevel(level) {
    const normalized = _safeTrim(level).toUpperCase();

    return VALID_LEVELS.has(normalized) ? normalized : "INFO";
}

function _normalizeEventType(eventType) {
    return (
        _normalizeIdPart(eventType, 60).toUpperCase() ||
        "UNKNOWN_EVENT"
    );
}

function _normalizeTraceId(traceId) {
    return _normalizeIdPart(traceId, 80) || "no-trace";
}

function _normalizeEntityId(entityId) {
    return (
        _normalizeIdPart(entityId || DEFAULT_ENTITY_ID, 80) ||
        DEFAULT_ENTITY_ID
    );
}

function _normalizeSource(source) {
    return (
        _normalizeIdPart(source || DEFAULT_SOURCE, 120) ||
        DEFAULT_SOURCE
    );
}

function _normalizeMessage(message) {
    return _cleanText(message, 1000) || "Audit event";
}

function _normalizeData(data) {
    if (!data || typeof data !== "object") {
        return {};
    }

    try {
        return _cloneDeep(data);
    } catch {
        return {
            details: "Audit data could not be cloned safely.",
        };
    }
}

function _buildAuditId(eventType, entityId, traceId) {
    const safeEventType = _normalizeIdPart(eventType, 60);
    const safeEntityId = _normalizeIdPart(entityId, 80);
    const safeTraceId = _normalizeIdPart(traceId, 80);

    const baseId = `AUDIT_${safeEventType}_${safeEntityId}_${safeTraceId}`;

    return baseId.slice(0, 190);
}

function _buildAuditRecord({
    eventType,
    level,
    message,
    data,
    traceId,
    entityId,
    source,
}) {
    const safeEventType = _normalizeEventType(eventType);
    const safeLevel = _normalizeLevel(level);
    const safeMessage = _normalizeMessage(message);
    const safeTraceId = _normalizeTraceId(traceId);
    const safeEntityId = _normalizeEntityId(entityId);
    const safeSource = _normalizeSource(source);

    return {
        _id: _buildAuditId(
            safeEventType,
            safeEntityId,
            safeTraceId
        ),
        eventType: safeEventType,
        level: safeLevel,
        message: safeMessage,
        data: _normalizeData(data),
        resourceId: safeEntityId,
        source: safeSource,
        traceId: safeTraceId,
        loggedAt: new Date(),
    };
}

// =============================================================================
// REGISTRO SINCRONO NO BLOQUEANTE
// =============================================================================

export async function logAuditEvent(
    eventType,
    level,
    message,
    data = {},
    traceId = null,
    entityId = DEFAULT_ENTITY_ID,
    source = DEFAULT_SOURCE
) {
    const record = _buildAuditRecord({
        eventType,
        level,
        message,
        data,
        traceId,
        entityId,
        source,
    });

    try {
        await wixData.insert(
            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
            _decorateControlAlert(record), { suppressAuth: true }
        );
    } catch (error) {
        log.error("logAuditEvent failed (non-blocking)", {
            message: error?.message || String(error),
            traceId: record.traceId,
            eventType: record.eventType,
        });
    }
}

function _decorateControlAlert(record) {
    // FASE3 ADR-05: alerts live in ControlOperativo with discriminator.
    return {
        ...record,
        controlType: CONTROL_TYPE.ALERT,
        dedupeKey: `ALERT_${record.traceId || record._id || Date.now()}`,
    };
}

// =============================================================================
// REGISTRO CON TIMEOUT
// =============================================================================

export async function logAuditEventWithTimeout(
    eventType,
    level,
    message,
    data = {},
    traceId = null,
    entityId = DEFAULT_ENTITY_ID,
    source = DEFAULT_SOURCE
) {
    const record = _buildAuditRecord({
        eventType,
        level,
        message,
        data,
        traceId,
        entityId,
        source
    });

    let timeoutHandle;

    try {
        const insertPromise = wixData
            .insert(
                OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
                _decorateControlAlert(record), { suppressAuth: true }
            )
            .catch((error) => {
                log.error("Audit insert failed", {
                    message: error?.message || String(error),
                    traceId: record.traceId,
                    eventType: record.eventType
                });

                return null;
            });

        const timeoutPromise = new Promise((resolve) => {
            timeoutHandle = setTimeout(() => {
                resolve(null);
            }, API_TIMEOUT_MS);
        });

        await Promise.race([
            insertPromise,
            timeoutPromise
        ]);
    } catch (error) {
        log.error("logAuditEventWithTimeout failed", {
            message: error?.message || String(error),
            traceId: record.traceId,
            eventType: record.eventType
        });
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}