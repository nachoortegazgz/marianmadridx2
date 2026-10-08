/*
=============================================================================
MODULE: backend/responseUtils.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Respuestas publicas, errores controlados y normalizacion
                de resultados de web methods.
STANDARDS: G10 ASCII Strict.
           Sin dependencias de Node.js.
           Sin exposicion de stacks ni secretos.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo importa _cloneDeep y
            _safeTrim de mmUtils (no renombrados) y opera sobre objetos
            genericos.

CORRECTIONS (heredadas):
  v5007.4.
=============================================================================
*/

import { _cloneDeep, _safeTrim } from "public/mmUtils";

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const MAX_ERROR_MESSAGE_LENGTH = 500;
const DEFAULT_ERROR_CODE = "INTERNAL_ERROR";
const DEFAULT_ERROR_MESSAGE = "Error interno";
const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";

// =============================================================================
// BLOQUE 2 - ERROR DE APLICACION
// =============================================================================

export class AppError extends Error {
    constructor(
        code = DEFAULT_ERROR_CODE,
        message = DEFAULT_ERROR_MESSAGE,
        meta = {}
    ) {
        super(String(message || DEFAULT_ERROR_MESSAGE));

        this.name = "AppError";
        this.code = String(code || DEFAULT_ERROR_CODE);
        this.meta = _cloneMeta(meta);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }
}

// =============================================================================
// BLOQUE 3 - HELPERS INTERNOS
// =============================================================================

function _cloneMeta(value) {
    if (!value || typeof value !== "object") {
        return value === undefined ? {} : { details: value };
    }

    try {
        return _cloneDeep(value);
    } catch {
        return {
            details: "Metadata could not be cloned safely.",
        };
    }
}

function _normalizeMeta(metaExtra) {
    if (!metaExtra || typeof metaExtra !== "object") {
        return {};
    }

    return _cloneMeta(metaExtra);
}

function _truncateMessage(value) {
    const rawMessage =
        value instanceof Error ?
        value.message || String(value) :
        String(value || "");

    const safeMessage = _safeTrim(rawMessage);

    if (safeMessage.length <= MAX_ERROR_MESSAGE_LENGTH) {
        return safeMessage;
    }

    return `${safeMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
}

function _extractErrorValues(code, message) {
    if (code instanceof Error) {
        return {
            code: code.code || code.name || UNKNOWN_ERROR_CODE,
            message: code.message || DEFAULT_ERROR_MESSAGE,
        };
    }

    if (code && typeof code === "object") {
        return {
            code: code.code || code.name || UNKNOWN_ERROR_CODE,
            message: code.message ||
                code.error ||
                code.reason ||
                DEFAULT_ERROR_MESSAGE,
        };
    }

    if (
        typeof code === "string" &&
        (message === undefined || message === null)
    ) {
        return {
            code: UNKNOWN_ERROR_CODE,
            message: code,
        };
    }

    return {
        code: code || DEFAULT_ERROR_CODE,
        message: message || DEFAULT_ERROR_MESSAGE,
    };
}

// =============================================================================
// BLOQUE 4 - RESPUESTAS PUBLICAS
// =============================================================================

export function successResponse(data = null, metaExtra = {}) {
    const extra = _normalizeMeta(metaExtra);

    return {
        status: "SUCCESS",
        meta: {
            timestamp: new Date().toISOString(),
            ...extra,
        },
        data,
        error: null,
    };
}

export function errorResponse(
    code = DEFAULT_ERROR_CODE,
    message = DEFAULT_ERROR_MESSAGE,
    metaExtra = {}
) {
    const extracted = _extractErrorValues(code, message);
    const safeMessage =
        _truncateMessage(extracted.message) || DEFAULT_ERROR_MESSAGE;

    const extra = _normalizeMeta(metaExtra);

    return {
        status: "ERROR",
        meta: {
            timestamp: new Date().toISOString(),
            ...extra,
        },
        data: null,
        error: {
            code: String(extracted.code || DEFAULT_ERROR_CODE),
            message: safeMessage,
        },
    };
}

// =============================================================================
// BLOQUE 5 - CONVERSION DE ERRORES PUBLICOS
// =============================================================================

export function _toPublicError(
    err,
    fallbackCode = DEFAULT_ERROR_CODE,
    fallbackMessage = DEFAULT_ERROR_MESSAGE
) {
    const code = err?.code || fallbackCode;
    const message = err?.message || fallbackMessage;

    return {
        code: String(code),
        message: _truncateMessage(message) || fallbackMessage,
    };
}

// =============================================================================
// BLOQUE 6 - ENVOLTORIO DE WEB METHODS
// =============================================================================

export function toWebMethodResult(actionFn) {
    if (typeof actionFn !== "function") {
        throw new TypeError("actionFn must be a function");
    }

    return async (...args) => {
        try {
            const result = await actionFn(...args);

            if (
                result &&
                typeof result === "object" &&
                typeof result.status === "string"
            ) {
                return result;
            }

            return successResponse(result);
        } catch (err) {
            return errorResponse(
                err?.code || err?.name || "OPERATION_FAILED",
                err?.message || "No se pudo procesar la solicitud."
            );
        }
    };
}

// =============================================================================
// BLOQUE 7 - VALIDACION DE RESULTADOS
// =============================================================================

export function isSuccess(response) {
    if (!response) {
        return false;
    }

    if (response === true) {
        return true;
    }

    const rawStatus =
        response?.status ??
        response?.payload?.status ??
        response?.data?.status;

    if (typeof rawStatus === "string") {
        const normalizedStatus = rawStatus.trim().toUpperCase();

        if (normalizedStatus === "SUCCESS" || normalizedStatus === "OK") {
            return true;
        }
    }

    return rawStatus === 200 || response?.success === true;
}