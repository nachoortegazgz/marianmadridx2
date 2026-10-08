/*
=============================================================================
MODULE: backend/securityEngine.js
VERSION: v8.1-SSOT-MASTER
BASE: BIBLIA v8.0-SSOT-MASTER + ANEXO SSOT v8.1
RESPONSIBILITY: Primitivas criptograficas (SHA-256, HMAC-SHA256), cadena de
                hash Veri*Factu, JWT HS256 y comparacion timing-safe.
STANDARDS: G10 ASCII Strict. Sin secretos hardcodeados. Sin console.log.

CORRECTIONS APPLIED (ANEXO v8.1):
  - BUG-02 FIX: JWT.MS_EXPIRACION → JWT.EXPIRATION_MS (nombre canonico)
  - Añadido buildRecordHash() para cadena Veri*Factu (Ley 11/2021)
  - Añadido buildClosingHash() para HistoricoCierresZ
  - Añadido signTimeclockRecord() para RegistrosHorariosStaff (RD 8/2019)
  - Añadido verifyTimeclockSignature() para auditoria laboral
=============================================================================
*/

import { secrets } from "@wix/secrets";
import { SECRETS } from "backend/mmSecrets";
import { JWT, INTEGRITY } from "backend/internalConfig";
import { logger } from "backend/logger";

const log = logger;

const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;
const ZERO_HASH = "0".repeat(64);

// =============================================================================
// BLOQUE 1 - UTILIDADES INTERNAS
// =============================================================================

function _toString(value) {
    if (value === null || value === undefined) return "";
    return String(value);
}

function _toUtf8Bytes(value) {
    const text = _toString(value);
    if (typeof TextEncoder === "function") {
        return new TextEncoder().encode(text);
    }
    return Uint8Array.from(
        unescape(encodeURIComponent(text)),
        (c) => c.charCodeAt(0)
    );
}

function _bytesToHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function _base64UrlEncode(value) {
    try {
        const bytes = _toUtf8Bytes(value);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
    } catch {
        return "";
    }
}

function _base64UrlDecode(value) {
    try {
        const normalized = _toString(value).replace(/-/g, "+").replace(/_/g, "/");
        const padded =
            normalized +
            "=".repeat((4 - (normalized.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        if (typeof TextDecoder === "function") {
            return new TextDecoder().decode(bytes);
        }
        let escaped = "";
        for (const byte of bytes) {
            escaped += `%${byte.toString(16).padStart(2, "0")}`;
        }
        return decodeURIComponent(escaped);
    } catch {
        return "";
    }
}

function _parseJson(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function _isValidHexSignature(value) {
    return HEX_64_PATTERN.test(_toString(value));
}

function _canonicalStringify(obj) {
    if (obj === null || obj === undefined) return "";
    if (typeof obj !== "object") return String(obj);
    if (Array.isArray(obj)) return `[${obj.map(_canonicalStringify).join(",")}]`;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
        (k) => `"${k}":${_canonicalStringify(obj[k])}`
    );
    return `{${parts.join(",")}}`;
}

// =============================================================================
// BLOQUE 2 - SHA-256
// =============================================================================

export async function hashSHA256(input) {
    const value = _toString(input);
    if (!value) return ZERO_HASH;

    if (
        typeof crypto !== "undefined" &&
        crypto?.subtle &&
        typeof TextEncoder === "function"
    ) {
        try {
            const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(value)
            );
            return _bytesToHex(new Uint8Array(digest));
        } catch (error) {
            log.error("hashSHA256 failed", {
                message: error?.message || String(error),
            });
            throw new Error("HASH_UNAVAILABLE");
        }
    }

    throw new Error("WEB_CRYPTO_UNAVAILABLE");
}

// =============================================================================
// BLOQUE 3 - HMAC-SHA256
// =============================================================================

export async function hmacSha256Hex(key, payload) {
    const keyValue = _toString(key);
    const payloadValue = _toString(payload);
    if (!keyValue || !payloadValue) return ZERO_HASH;

    if (
        typeof crypto !== "undefined" &&
        crypto?.subtle &&
        typeof TextEncoder === "function"
    ) {
        try {
            const encoder = new TextEncoder();
            const cryptoKey = await crypto.subtle.importKey(
                "raw",
                encoder.encode(keyValue),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign"]
            );
            const signature = await crypto.subtle.sign(
                "HMAC",
                cryptoKey,
                encoder.encode(payloadValue)
            );
            return _bytesToHex(new Uint8Array(signature));
        } catch (error) {
            log.error("hmacSha256Hex failed", {
                message: error?.message || String(error),
            });
            throw new Error("HMAC_UNAVAILABLE");
        }
    }

    throw new Error("WEB_CRYPTO_UNAVAILABLE");
}

// =============================================================================
// BLOQUE 4 - CADENA DE HASH VERI*FACTU (Ley 11/2021)
// =============================================================================

export async function hashChain(previousHash, payload) {
    const previous = _toString(previousHash) || ZERO_HASH;
    const content = _toString(payload);
    return hashSHA256(`${previous}|${content}`);
}

/**
 * Construye el recordHash canonico de MovimientosCaja.
 * Payload canonico: campos fiscales clave ordenados alfabeticamente.
 * @param {Object} movement - Movimiento de caja (sin recordHash).
 * @param {string} previousRecordHash - Hash del movimiento anterior.
 * @returns {Promise<string>} SHA-256 hex de 64 caracteres.
 */
export async function buildRecordHash(movement, previousRecordHash) {
    if (!movement || typeof movement !== "object") {
        throw new Error("HASH_INPUT_INVALID: movement must be an object");
    }

    const canonicalPayload = _canonicalStringify({
        numSerieFactura: movement.numSerieFactura,
        sequenceNumber: movement.sequenceNumber,
        transactionId: movement.transactionId,
        recordTimestamp: movement.recordTimestamp,
        tipoFactura: movement.tipoFactura,
        fechaExpedicionFactura: movement.fechaExpedicionFactura,
        baseImponibleOImporteNoSujeto: movement.baseImponibleOImporteNoSujeto,
        tipoImpositivo: movement.tipoImpositivo,
        cuotaTotal: movement.cuotaTotal,
        totalAmount: movement.totalAmount,
        nifEmisor: movement.nifEmisor,
        nifDestinatario: movement.nifDestinatario,
        schemaVersion: movement.schemaVersion || INTEGRITY.LEDGER_SCHEMA_VERSION,
    });

    return hashChain(previousRecordHash, canonicalPayload);
}

/**
 * Construye el closingHash de HistoricoCierresZ.
 * @param {Object} closing - Cierre Z (sin closingHash).
 * @returns {Promise<string>} SHA-256 hex.
 */
export async function buildClosingHash(closing) {
    if (!closing || typeof closing !== "object") {
        throw new Error("HASH_INPUT_INVALID: closing must be an object");
    }

    const canonicalPayload = _canonicalStringify({
        recordDomain: closing.recordDomain,
        operationDate: closing.operationDate,
        startSequence: closing.startSequence,
        endSequence: closing.endSequence,
        startRecordHash: closing.startRecordHash,
        endRecordHash: closing.endRecordHash,
        consolidatedTotalAmount: closing.consolidatedTotalAmount,
        netTaxableAmount: closing.netTaxableAmount,
        netTaxAmount: closing.netTaxAmount,
    });

    return hashSHA256(canonicalPayload);
}

// =============================================================================
// BLOQUE 5 - FIRMA HMAC DE FICHAJES (RD 8/2019)
// =============================================================================

/**
 * Firma un registro horario con HMAC-SHA256.
 * @param {Object} record - Registro de fichaje.
 * @returns {Promise<string>} Firma hex de 64 caracteres.
 */
export async function signTimeclockRecord(record) {
    if (!record || typeof record !== "object") {
        throw new Error("SIGN_INPUT_INVALID: record must be an object");
    }

    const secret = await secrets.getSecretValue(SECRETS.AUTH_JWT_KEY);
    if (!secret) throw new Error("AUTH_JWT_KEY_NOT_FOUND");

    const canonicalPayload = _canonicalStringify({
        resourceId: record.resourceId,
        memberId: record.memberId,
        recordedAt: record.recordedAt,
        clockEventType: record.clockEventType,
        recordType: record.recordType,
        adjustmentReason: record.adjustmentReason || null,
        traceId: record.traceId,
    });

    return hmacSha256Hex(secret, canonicalPayload);
}

/**
 * Verifica la firma HMAC de un registro horario.
 * @param {Object} record - Registro con campo signature.
 * @returns {Promise<boolean>} true si la firma es valida.
 */
export async function verifyTimeclockSignature(record) {
    if (!record || !_isValidHexSignature(record.signature)) return false;

    const payload = { ...record };
    delete payload.signature;

    const expected = await signTimeclockRecord(payload);
    return timingSafeEqual(record.signature.toLowerCase(), expected.toLowerCase());
}

// =============================================================================
// BLOQUE 6 - COMPARACION TIMING-SAFE
// =============================================================================

export function timingSafeEqual(first, second) {
    const a = _toString(first);
    const b = _toString(second);
    const maxLength = Math.max(a.length, b.length);
    let result = a.length ^ b.length;

    for (let i = 0; i < maxLength; i += 1) {
        const charA = i < a.length ? a.charCodeAt(i) : 0;
        const charB = i < b.length ? b.charCodeAt(i) : 0;
        result |= charA ^ charB;
    }

    return result === 0;
}

// =============================================================================
// BLOQUE 7 - JWT HS256 (BUG-02 FIX: JWT.EXPIRATION_MS)
// =============================================================================

export async function generateJWT(payload, traceId = null) {
    try {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("INVALID_JWT_PAYLOAD");
        }
        if (JWT.ALGORITHM !== "HS256") {
            throw new Error("UNSUPPORTED_JWT_ALGORITHM");
        }

        const secret = await secrets.getSecretValue(SECRETS.AUTH_JWT_KEY);
        if (!secret) throw new Error("AUTH_JWT_KEY_NOT_FOUND");

        // BUG-02 FIX: JWT.EXPIRATION_MS (antes JWT.MS_EXPIRACION inexistente)
        const expirationMs = Number(JWT.EXPIRATION_MS);
        if (!Number.isFinite(expirationMs) || expirationMs <= 0) {
            throw new Error("JWT_EXPIRATION_MS_INVALID");
        }

        const issuedAt = Math.floor(Date.now() / 1000);
        const expiration = issuedAt + Math.floor(expirationMs / 1000);

        if (!Number.isFinite(expiration) || expiration <= issuedAt) {
            throw new Error("INVALID_JWT_EXPIRATION");
        }

        const header = { alg: "HS256", typ: "JWT" };
        const tokenPayload = { ...payload, iat: issuedAt, exp: expiration };

        const encodedHeader = _base64UrlEncode(JSON.stringify(header));
        const encodedPayload = _base64UrlEncode(JSON.stringify(tokenPayload));

        if (!encodedHeader || !encodedPayload) {
            throw new Error("JWT_ENCODING_FAILED");
        }

        const signingInput = `${encodedHeader}.${encodedPayload}`;
        const signature = await hmacSha256Hex(secret, signingInput);

        if (!_isValidHexSignature(signature)) {
            throw new Error("JWT_SIGNATURE_FAILED");
        }

        return `${signingInput}.${signature}`;
    } catch (error) {
        log.error("generateJWT failed", {
            message: error?.message || String(error),
            traceId,
        });
        throw error;
    }
}

export async function verifyJWT(token, traceId = null) {
    try {
        const rawToken = _toString(token);
        const parts = rawToken.split(".");

        if (parts.length !== 3 || parts.some((p) => !p)) return null;

        const header = _parseJson(_base64UrlDecode(parts[0]));
        const payload = _parseJson(_base64UrlDecode(parts[1]));

        if (!header || !payload) return null;
        if (header.alg !== "HS256" || header.typ !== "JWT") return null;

        const secret = await secrets.getSecretValue(SECRETS.AUTH_JWT_KEY);
        if (!secret) throw new Error("AUTH_JWT_KEY_NOT_FOUND");

        const signingInput = `${parts[0]}.${parts[1]}`;
        const expectedSignature = await hmacSha256Hex(secret, signingInput);

        if (
            !_isValidHexSignature(parts[2]) ||
            !_isValidHexSignature(expectedSignature) ||
            !timingSafeEqual(parts[2].toLowerCase(), expectedSignature)
        ) {
            return null;
        }

        const now = Math.floor(Date.now() / 1000);

        if (!Number.isFinite(Number(payload.exp))) return null;
        if (Number(payload.exp) <= now) return null;
        if (
            payload.nbf !== undefined &&
            (!Number.isFinite(Number(payload.nbf)) || Number(payload.nbf) > now)
        ) {
            return null;
        }

        return payload;
    } catch (error) {
        log.error("verifyJWT failed", {
            message: error?.message || String(error),
            traceId,
        });
        return null;
    }
}

// =============================================================================
// BLOQUE 8 - HASH DE INTEGRIDAD DE ESTADO (CajaActual.stateHash)
// =============================================================================

export async function buildStateHash(state) {
    if (!state || typeof state !== "object") {
        throw new Error("HASH_INPUT_INVALID: state must be an object");
    }

    const snapshot = { ...state };
    delete snapshot.stateHash;
    delete snapshot.versionState;
    delete snapshot._updatedDate;

    return hashSHA256(_canonicalStringify(snapshot));
}
