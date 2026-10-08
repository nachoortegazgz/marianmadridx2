/*
MODULE: backend/booking/bookingCore.js
VERSION: v5009-FISCAL-V20.2-CORE
BASE: v5009-FISCAL-V20.1 + Alineacion con bookingSaga v5009-FISCAL-V20.3
RESPONSIBILITY: Capa de acceso y primitivas atomicas para reservas.
STANDARDS: ASCII only. No Node builtins.

FIXES APLICADOS v5009-FISCAL-V20.2:
  - CORE-01: _extractResourceIdsFromSlot acepta resourceTypeId,
             resourceType.id, resourceType._id y typeId. Paridad 1:1 con
             reservas.web._getResourceIdsFromSlot. Extrae tambien
             resource.resourceId. Sin este fix, _projectCertifiedSlot
             devolvia availableResources: [] con la variante anidada de Wix.
  - CORE-02: _forceStaffInPristineSlot PRESERVA addOnIds / selectedAddOns
             en el slot final. Antes los addOnOptions detectados por bookingSaga
             se perdia antes de createBooking (precio/duracion incorrectos).
  - CORE-03: _projectWriterSlotFromAvailability exige scheduleId GUID
             valido (cascada projected -> slot -> slot.slot). Devuelve null
             si no hay scheduleId util, en vez de proyectar scheduleId: "".
  - CORE-04: _projectCertifiedSlot valida locationId contra
             SDK_CONFIG.LOCATION_ID. Si el slot trae otra ubicacion,
             devuelve null (fail-fast) en vez de sustituirla en silencio.
             locationId resultante debe ser GUID valido.
  - CORE-05: Huella de pairToken CANONICA compartida.
             _buildPairFingerprint + _buildPairTokenDeterministic son la
             UNICA fuente de verdad. reservas.web.js y bookingSaga.js deben
             importarlas (ver parches de consumo mas abajo). Incluye los 8
             campos exigidos: serviceId, linkedPhases, dateYmd, f1Start,
             f1End, f2Start, f2End, resourceId.
             _generatePairToken(traceId) queda SOLO como legacy no
             determinista (no usar para correlacion dual).
  - CORE-06: confirmOrDeclineBookingElevated traduce paymentStatus del
             SSOT espanol (IMPAGADO, NO_PAGADO, PAGADO...) al enum nativo
             de Wix (NOT_PAID, PAID...) segun BIBLIA 3.2.1.
             Resuelve el riesgo SAGA-05: la saga envia PAYMENT_STATUS.NOT_PAID
             ("IMPAGADO") y Wix solo acepta el enum nativo ingles.
             Valores ingleses pasan sin cambios (back-compat total).
  - CORE-07: Constantes CONCURRENCY V20 canonicas (BIBLIA 3.2.1 filas
             15-17: MS_TTL_MUTEX, MS_LATIDO, MS_TTL_MUTEX_ASIENTO).
             v5010.4 FASE 2: internalConfig ya solo expone los nombres V20;
             las cascadas de transicion legacy se eliminaron. TRANSACTION_
             POLL_BASE_MS / TRANSACTION_MAX_WAIT_MS se conservan porque la
             norma no documenta equivalente V20 (grep BIBLIA/SSOT1 vacio).
             _persistBooking y _rankResourcesByLoad toleran alias de estado
             CONFIRMADO / PENDIENTE_PAGO / CANCELADO junto a los nativos
             ingleses (esos alias son del DOMINIO Wix/CitasF2, no del SSOT).

HISTORIAL (heredado):
  v5009-FISCAL-V20.1 | Sin renombrados funcionales (esquema corto CitasF2).
  v5008.6 | 2026-09-20 | Alineacion final: FIX-32, FIX-33, FIX-43.
  v5008.5 | 2026-09-19 | COHERENCIA scheduleId: CORE-16, CORE-17.
  v5008.4 | 2026-09-19 | Date range, scheduleId obligatorio, cache validaciones.
  v5008.3 | 2026-09-19 | Restauracion de exports faltantes.
  v5008.2 | 2026-09-15 | Aligned + dead code removed.
=============================================================================
*/

import { bookings } from "@wix/bookings";
// AUDIT-FIX v5010.3 (TAREA 4): import ecom migrado al SDK unificado V2
// "@wix/ecom" (cero legacy). Firmas equivalentes:
// checkout.createCheckout(request) y checkout.getCheckoutUrl(id, opts).
import { checkout } from "@wix/ecom";
import { elevate } from "@wix/sdk";
// EXCEPCION DATA API (APENDICE C de la BIBLIA): lectura/escritura CMS
// server-side via wixData con suppressAuth; ver apendice para el porque
// no se migra a datasets.query('@wix/data').queryDataItems().
import wixData from "backend/dataAccess";
import { getStaffScheduleId } from "backend/staff";
import { logger } from "backend/logger";
import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONCURRENCY,
    normalizeBookingType,
    isDualBookingType,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    PAYMENT_STATUS,
    BOOKING_STATUS,
    INACTIVE_BOOKING_STATUSES,
    BOOKING_FIELDS,
} from "backend/internalConfig";
import {
    _safeTrim,
    _looksLikeGuid,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    makeTraceId,
    _toDateSafe,
    _hashKey,
    _normalizeLocalIsoStr,
} from "public/mmUtils";
import {
    computeGapMinutes,
    getResourceIdsFromSlot,
    // v5010.4 (FASE 2): huella canonica definida en bookingUtils (capa de
    // utilidades puras, segun precedencia mmUtils > bookingUtils > core > web).
    // Evita el ciclo bookingUtils -> bookingCore que se habia introducido.
    _buildPairFingerprint,
} from "backend/booking/bookingUtils";

const log = logger;

// FIX-32: STAFF_RESOURCE_TYPE_ID via SSOT.
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

// v5010.4 (FASE 2): unica definicion de la huella en bookingUtils; aqui solo
// se REEXPORTA la superficie publica historica (sin duplicar logica) y se
// define el token determinista canonico sobre esa huella (CORE-05).
export { _buildPairFingerprint };

// CORE-07:Ubicacion configurada, normalizada una sola vez.
const CONFIGURED_LOCATION_ID = _safeTrim(SDK_CONFIG?.LOCATION_ID);

// =============================================================================
// BLOQUE 1 - CODIGOS DE ERROR (25 codigos)
// =============================================================================

export const ERROR_CODES = Object.freeze({
    INVALID_PAYLOAD: "INVALID_PAYLOAD",
    TOKEN_BUSY: "TOKEN_BUSY",
    FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
    FISCAL_VIOLATION: "FISCAL_VIOLATION",
    BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
    CHECKOUT_FAILED: "CHECKOUT_FAILED",
    INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    ACCESS_DENIED: "ACCESS_DENIED",
    INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
    RATE_LIMITED: "RATE_LIMITED",
    SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
    STAFF_UNAVAILABLE: "STAFF_UNAVAILABLE",
    SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
    LOCATION_MISMATCH: "LOCATION_MISMATCH",
    LOCK_KEY_OR_OWNER_INVALID: "LOCK_KEY_OR_OWNER_INVALID",
    LOCK_HELD_BY_ANOTHER_OWNER: "LOCK_HELD_BY_ANOTHER_OWNER",
    LOCK_EXPIRED_PENDING_CLEANUP: "LOCK_EXPIRED_PENDING_CLEANUP",
    LOCK_RENEWAL_FAILED: "LOCK_RENEWAL_FAILED",
    TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
    PAIR_TOKEN_PAYLOAD_MISMATCH: "PAIR_TOKEN_PAYLOAD_MISMATCH",
    TRANSACTION_PREVIOUSLY_FAILED: "TRANSACTION_PREVIOUSLY_FAILED",
    INVALID_SLOT_RECHECK: "INVALID_SLOT_RECHECK",
    DATABASE_ERROR: "DATABASE_ERROR",
    INVALID_DATES: "INVALID_DATES",
    UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// =============================================================================
// BLOQUE 2 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================
// v5010.6: superficie reducida a los proxies con consumidor real.
//   cancelBookingElevated -> bookingSaga (compensacion SAGA-06) + crons.js.
//   confirmOrDecline...   -> bookingSaga (paso ConfirmPresencial, CORE-06).
//   createCheckout/getCheckoutUrl -> bookingSaga (flujo ONLINE).
// createBookingElevated y rescheduleBookingElevated eliminados: cero
// consumidores en src/ y tools/. La creacion usa elevacion selectiva
// (bookingSaga._createBookingWithSelectiveElevation, FIX-37), que solo
// eleva bajo ACCESS_DENIED; el reprogramado no tiene flujo activo.

export const cancelBookingElevated = elevate(bookings.cancelBooking);
export const createCheckoutElevated = elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = elevate(checkout.getCheckoutUrl);

// CORE-06: Mapa paymentStatus SSOT espanol -> enum nativo Wix (BIBLIA 3.2.1).
// Los valores nativos ingleses NO aparecen como clave: pasan sin traduccion,
// lo que garantiza compatibilidad total con consumidores existentes.
const WIX_NATIVE_PAYMENT_STATUS = Object.freeze({
    // Values already canonical EN (Wix Bookings). Identity pass-through.
    UNDEFINED: "UNDEFINED",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PAID: "PAID",
    PARTIALLY_PAID: "PARTIALLY_PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    EXEMPT: "EXEMPT",
    // Optional UI labels (ES) -> Wix native EN (never stored in CMS)
    IMPAGADO: "NOT_PAID",
    NO_PAGADO: "NOT_PAID",
    PAGADO: "PAID",
    PARCIALMENTE_PAGADO: "PARTIALLY_PAID",
    REEMBOLSADO: "REFUNDED",
    REEMBOLSADO_PARCIAL: "PARTIALLY_REFUNDED",
});

function _toWixNativePaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return value;
    return WIX_NATIVE_PAYMENT_STATUS[v] || value;
}

const _confirmOrDeclineElevatedRaw = elevate(bookings.confirmOrDeclineBooking);

/**
 * CORE-06: Wrapper elevado que traduce el paymentStatus del SSOT (espanol)
 * al enum nativo que acepta Wix Bookings. bookingSaga v20.3 envia
 * PAYMENT_STATUS.NOT_PAID; sin esta traduccion Wix rechaza la
 * confirmacion presencial.
 *
 * Contrato preservado: (bookingId, options) -> respuesta nativa elevada.
 */
export async function confirmOrDeclineBookingElevated(bookingId, options) {
    let normalizedOptions = options;

    if (options && typeof options === "object" && options.paymentStatus !== undefined) {
        const translated = _toWixNativePaymentStatus(options.paymentStatus);
        if (translated !== options.paymentStatus) {
            log.info("CORE-06: paymentStatus translated SSOT -> Wix native", {
                bookingId: _safeTrim(bookingId),
                from: options.paymentStatus,
                to: translated,
            });
        }
        normalizedOptions = Object.assign({}, options, { paymentStatus: translated });
    }

    return _confirmOrDeclineElevatedRaw(bookingId, normalizedOptions);
}

// Back-compat: some modules historically imported logger from this file.
export { logger };

// =============================================================================
// BLOQUE 3 - CLASE BOOKINGERROR
// =============================================================================

export class BookingError extends Error {
    constructor(code, message, details = {}) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
        this.details = details && typeof details === "object" ? details : { details };
        this.timestamp = new Date().toISOString();
    }
}

export function createBookingError(code, message, details) {
    return new BookingError(code, message, details);
}

// =============================================================================
// BLOQUE 4 - NORMALIZACION DE ERRORES
// =============================================================================

export function normalizeError(err) {
    if (err && typeof err === "object" && err.name === "BookingError") {
        return {
            code: String(err.code || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details || {},
        };
    }
    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details && typeof err.details === "object" ? err.details : {},
        };
    }
    if (typeof err === "string") {
        return { code: ERROR_CODES.UNKNOWN_ERROR, message: err, stack: null, details: {} };
    }
    if (err && typeof err === "object") {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || err.error || "Unknown error"),
            stack: err.stack || null,
            details: {},
        };
    }
    return { code: ERROR_CODES.UNKNOWN_ERROR, message: "Unknown error", stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    loggerInstance.error("[" + context + "] " + norm.code + ": " + norm.message, {
        traceId,
        details: norm.details,
    });
    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
            message: norm.message || "Unknown error",
        },
    };
}

// =============================================================================
// BLOQUE 5 - RESOLUCION DE SCHEDULEID (FALLBACK CONTROLADO)
// =============================================================================

async function _resolveScheduleIdByResourceId(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return null;
    const scheduleId = await getStaffScheduleId(id);
    return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const s = (sourceSlot && typeof sourceSlot === "object") ? sourceSlot : {};
    let scheduleId = _safeTrim(
        s.scheduleId || s.slot?.scheduleId || s.schedule?.id || s.resource?.scheduleId || ""
    );
    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;

    scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    return scheduleId || null;
}

// =============================================================================
// BLOQUE 6 - NORMALIZACION DE SLOTS PARA WRITER V2 (CORE-02, CORE-04)
// =============================================================================

/**
 * CORE-02: Extraccion tolerante de addOnOptions desde el slot entrante.
 * Fuentes aceptadas (por orden): slot.addOnIds, slot.selectedAddOns,
 * slot.customerChoices.addOnIds (forma usada en disponibilidad).
 * Solo se conservan GUIDs validos, deduplicados.
 */
function _extractAddonIdsFromSlot(slot) {
    const candidates = [].concat(
        Array.isArray(slot?.addOnIds) ? slot.addOnIds : [],
        Array.isArray(slot?.selectedAddOns) ? slot.selectedAddOns : [],
        Array.isArray(slot?.customerChoices?.addOnIds) ? slot.customerChoices.addOnIds : []
    );

    const clean = candidates
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); });

    return Array.from(new Set(clean));
}

export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId });
        return null;
    }

    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || slot.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceIdClean });
        return null;
    }

    let scheduleId = _safeTrim(
        slot.scheduleId || slot.slot?.scheduleId || slot.schedule?.id || slot.resource?.scheduleId || ""
    );
    if (!scheduleId) {
        scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    }
    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.error("_forceStaffInPristineSlot: missing scheduleId", { resourceId: resourceIdClean });
        return null;
    }

    let localStartDate = "";
    const rawStart = slot.localStartDate || slot.startDate;
    if (rawStart instanceof Date) localStartDate = getMadridLocalStringNoZ(rawStart);
    else if (typeof rawStart === "string" && rawStart.endsWith("Z")) {
        const utcDt = new Date(rawStart);
        localStartDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localStartDate = _safeTrim(rawStart);
    if (!localStartDate) return null;

    let localEndDate = "";
    const rawEnd = slot.localEndDate || slot.endDate;
    if (rawEnd instanceof Date) localEndDate = getMadridLocalStringNoZ(rawEnd);
    else if (typeof rawEnd === "string" && rawEnd.endsWith("Z")) {
        const utcDt = new Date(rawEnd);
        localEndDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localEndDate = _safeTrim(rawEnd);

    if (!localEndDate) {
        const startUtc = getUtcDateFromMadridLocal(localStartDate);
        if (!startUtc) return null;
        const durationMin = Number(defaultDurationMinutes || CONCURRENCY?.DEFAULT_DURATION_MIN || 30);
        localEndDate = getMadridLocalStringNoZ(new Date(startUtc.getTime() + durationMin * 60 * 1000));
    }

    const startDate = getUtcDateFromMadridLocal(localStartDate);
    const endDate = getUtcDateFromMadridLocal(localEndDate);
    if (!startDate || !endDate) return null;

    if (endDate.getTime() <= startDate.getTime()) {
        log.error("_forceStaffInPristineSlot: invalid date range (endDate <= startDate)", {
            localStartDate,
            localEndDate,
            resourceId: resourceIdClean,
            serviceId,
        });
        return null;
    }

    // CORE-04: validacion de ubicacion entrante contra la configurada.
    // Si el slot trae OTRA ubicacion, fail-fast: nunca se sustituye en
    // silencio (evitaria crear la reserva en un local equivocado).
    const incomingLocationId = _safeTrim(slot.location?.id);
    if (
        incomingLocationId &&
        CONFIGURED_LOCATION_ID &&
        incomingLocationId !== CONFIGURED_LOCATION_ID
    ) {
        log.error("_forceStaffInPristineSlot: slot location conflicts with configured location", {
            slotLocationId: incomingLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId,
        });
        return null;
    }

    const locationId = CONFIGURED_LOCATION_ID || incomingLocationId;
    if (!locationId || !_looksLikeGuid(locationId)) {
        log.error("_forceStaffInPristineSlot: missing or invalid LOCATION_ID", {
            configuredLocationId: CONFIGURED_LOCATION_ID,
            incomingLocationId: incomingLocationId,
        });
        return null;
    }

    // BIBLIA 2.2.1 fila 8: creacion SIEMPRE con OWNER_BUSINESS.
    let locationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER) || "OWNER_BUSINESS";
    if (locationType === "BUSINESS") locationType = "OWNER_BUSINESS";
    const timezone = _safeTrim(SDK_CONFIG?.TZ) || "Europe/Madrid";

    const result = {
        serviceId,
        scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone,
        resource: { id: resourceIdClean },
        location: { id: locationId, locationType },
    };

    // CORE-02: preservar addOnOptions para createBooking. Se emiten ambas claves
    // porque bookingSaga v20.3 inyecta addOnIds + selectedAddOns y el
    // contrato del Writer V2 ha usado historicamente las dos formas.
    const addOnIds = _extractAddonIdsFromSlot(slot);
    if (addOnIds.length > 0) {
        result.addOnIds = addOnIds.slice();
        result.selectedAddOns = addOnIds.slice();
    }

    return result;
}

// =============================================================================
// BLOQUE 7 - CHECKOUT URL HELPER
// =============================================================================

export function _extractCheckoutId(checkoutSession) {
    return checkoutSession?.checkout?._id || checkoutSession?._id || null;
}

// =============================================================================
// BLOQUE 8 - MUTEX LOCKS (SlotLocks) - CORE-07 renombrado V20
// =============================================================================

// CORE-07 / v5010.4 (FASE 2): BIBLIA 3.2.1 f15 renombro MUTEX_TTL_MS ->
// MS_TTL_MUTEX y el SSOT (internalConfig) ya solo expone el nombre V20, por
// lo que la cascada de transicion se elimina (cero codigo de fallback inutil).
const MUTEX_TTL_MS = Number(CONCURRENCY?.MS_TTL_MUTEX);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}
// FASE4 (ADR-05): SlotLocks absorbida en ControlOperativo (discriminador
// controlType=SLOT_LOCK). Las escrituras purgan el payload de documento
// fisico antiguo y persisten el esquema canonico de ControlOperativo.
const LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing) {
    const now = new Date();
    return {
        _id: _safeLockId(slotClave),
        controlType: CONTROL_TYPE.SLOT_LOCK,
        dedupeKey: String(slotClave),
        slotKey: String(slotClave),
        lockOwnerId: String(lockOwnerId || makeTraceId("lock")),
        status: "ACTIVE",
        traceId: String(lockOwnerId || ""),
        expiresAt: new Date(Date.now() + (Number(ttlMs) || MUTEX_TTL_MS)),
        _createdDate: existing?._createdDate ? _toDateSafe(existing._createdDate) || now : now,
        _updatedDate: now,
    };
}

export function _safeLockId(key) {
    const k = String(key || "").trim();
    if (!k) return "";
    return "lk_" + _hashKey(k) + "_" + k.slice(0, 24);
}

async function _getLock(slotClave) {
    const k = String(slotClave || "");
    if (!k) return null;
    const item = await wixData
        .get(LOCKS_COL, _safeLockId(k), { suppressAuth: true, consistentRead: true })
        .catch(() => null);
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    return _safeTrim(lock.lockOwnerId || lock.traceId || "");
}

function _isDuplicateItemError(error) {
    const message = String(error?.message || "");
    return message.includes("WDE0123") || message.includes("WD_ITEM_ALREADY_EXISTS") || message.includes("Duplicated");
}

function _buildLockDocument(slotClave, lockOwnerId, ttlMs, existing) {
    // FASE4: delegacion al constructor canonico ControlOperativo/SLOT_LOCK.
    return _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing);
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    const k = String(slotClave || "");
    const owner = String(lockOwnerId || "").trim();
    if (!k || !owner) return { ok: false, message: "LOCK_KEY_OR_OWNER_INVALID" };

    try {
        await wixData.insert(LOCKS_COL, _buildLockDocument(k, owner, ttlMs), { suppressAuth: true });
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, error: error?.message });
            return { ok: false, message: error?.message || "Lock acquisition failed" };
        }
        const existing = await _getLock(k);
        const currentOwner = _getLockOwnerId(existing);
        if (currentOwner === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok ? { ok: true, renewed: true } : { ok: false, message: "LOCK_RENEWAL_FAILED" };
        }
        const expiresAt = _toDateSafe(existing?.expiresAt);
        const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        if (expired && existing?._id) {
            await wixData.remove(LOCKS_COL, existing._id, { suppressAuth: true }).catch(() => null);
            try {
                await wixData.insert(LOCKS_COL, _buildLockDocument(k, owner, ttlMs), { suppressAuth: true });
                return { ok: true, acquired: true, reclaimed: true };
            } catch (_) {
                return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
            }
        }
        return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
    }
}

export async function _unlockSlotKey(slotClave, lockOwnerId) {
    const owner = String(lockOwnerId || "").trim();
    const existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    const currentOwner = _getLockOwnerId(existing);
    if (!owner || currentOwner !== owner) return { ok: false, skipped: true };
    await wixData.remove(LOCKS_COL, existing._id, { suppressAuth: true });
    return { ok: true };
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs) {
    try {
        const owner = String(lockOwnerId || "").trim();
        const existing = await _getLock(slotClave);
        if (!existing) return { ok: false };
        const currentOwner = _getLockOwnerId(existing);
        if (!owner || currentOwner !== owner) return { ok: false };
        await wixData.update(LOCKS_COL, _buildLockDocument(slotClave, owner, ttlMs, existing), { suppressAuth: true });
        return { ok: true };
    } catch (error) {
        log.error("_renewLock failed", { slotClave, error: error?.message });
        return { ok: false };
    }
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS
// =============================================================================

export function _generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date ? startDate : getUtcDateFromMadridLocal(startDate);
    const endUtc = endDate instanceof Date ? endDate : getUtcDateFromMadridLocal(endDate);
    if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid slot dates for lock key");
    }
    const startEpochMin = Math.floor(startUtc.getTime() / 60000);
    const endEpochMin = Math.floor(endUtc.getTime() / 60000);
    const raw = String(serviceId || "").trim() + "|" + String(resourceId || "").trim() + "|" + startEpochMin + "|" + endEpochMin;
    const prefix = serviceId ? String(serviceId).slice(0, 8) : "srv";
    const staffPrefix = resourceId ? String(resourceId).slice(0, 8) : "nostaff";
    return "slot_" + prefix + "_" + staffPrefix + "_" + _hashKey(raw);
}

export function _buildLockKeys(phases, resourceId) {
    const keys = (phases || []).map(function (p) {
        const slot = p?.rawSlot || {};
        return _generateSlotKey(slot.serviceId, resourceId, p.localStart, p.localEnd);
    });
    return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - TRANSACCIONES IDEMPOTENTES (BookingTransactions) - CORE-07
// =============================================================================

// FASE4 (ADR-05): BookingTransactions absorbida en ControlOperativo
// (controlType=BOOKING_TX).
const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

// CORE-07: tolerancia al renombrado V20 (BIBLIA 3.2.1).
// SIN EQUIVALENTE V20 DOCUMENTADO en BIBLIA 3.2.1 para estas dos claves
// (grep verifico: MS_SONDEO_TRANSACCION / MS_ESPERA_MAX_TRANSACCION no
// existen en la norma). Se mantiene el nombre actual como canonico del SSOT.
const TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY?.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY?.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    const id = String(pairToken || "");
    if (!id) return null;
    return await wixData.get(TRANSACTIONS_COL, id, { suppressAuth: true, consistentRead: true }).catch(() => null);
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = String(pairToken || "");
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    try {
        await wixData.insert(
            TRANSACTIONS_COL, {
                _id: id,
                pairToken: id,
                status: "PENDING",
                payloadHash,
                traceId,
                _createdDate: new Date(),
                _updatedDate: new Date(),
            }, { suppressAuth: true }
        );
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) throw error;

        const startTime = Date.now();
        let pollAttempt = 0;
        while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
            const existing = await _getTransactionById(id);
            if (existing) {
                if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                    return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                }
                if (existing.status === "COMPLETED") return { success: true, isNew: false, existing };
                if (existing.status === "FAILED") {
                    return { success: false, error: "TRANSACTION_PREVIOUSLY_FAILED", existing };
                }
            }
            const remainingMs = TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
            const delay = Math.min(
                Math.floor(TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3)) * (0.5 + Math.random())),
                remainingMs
            );
            if (delay <= 0) break;
            pollAttempt++;
            await new Promise(function (r) { setTimeout(r, delay); });
        }

        const existing = await _getTransactionById(id);
        if (existing) {
            if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
            }
            return { success: false, error: "TRANSACTION_TIMEOUT", existing, timeout: true };
        }
        return { success: false, error: "TRANSACTION_TIMEOUT" };
    }
}

export async function _completeTransaction(pairToken, result, traceId) {
    const id = String(pairToken || "");
    if (!id) return;
    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;
    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "COMPLETED",
        result,
        ownerTraceId: String(traceId || existing?.ownerTraceId || ""),
        _updatedDate: new Date(),
        _createdDate: existing?._createdDate || new Date(),
    };
    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true });
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true });
}

export async function _failTransaction(pairToken, errorMessage) {
    const id = String(pairToken || "");
    if (!id) return;
    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;
    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "FAILED",
        error: String(errorMessage || "UNKNOWN_ERROR"),
        _updatedDate: new Date(),
        _createdDate: existing?._createdDate || new Date(),
    };
    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
}

// =============================================================================
// BLOQUE 11 - PERSISTENCIA EN CITAS_F2 (CORE-07: alias de estado)
// =============================================================================

const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

// CORE-07: statuses use SSOT EN = Wix native. No dual alias lists.
// FASE2 (ADR-06): the CitasF2 PHYSICAL canonical field is bookingStatus
// (BOOKING_FIELDS.STATUS). The legacy "status" key is accepted on READ only
// as a transitional fallback and is NEVER written to the document anymore.
// Zero-fallback-on-write rule (MATRIZ H / transversal).
export async function _persistBooking(params, traceId) {
    const p = params || {};
    const bookingId = p.bookingId;
    const serviceId = p.serviceId;
    const resourceId = p.resourceId;
    const startDate = p.startDate;
    const endDate = p.endDate;
    if (!bookingId || !serviceId || !resourceId || !startDate || !endDate) {
        throw new Error("Missing required fields for persistBooking");
    }

    const scheduleIdClean = _safeTrim(p.scheduleId);
    if (!scheduleIdClean || !_looksLikeGuid(scheduleIdClean)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "scheduleId is required and must be a valid GUID for CitasF2 persistence", { traceId, bookingId: String(bookingId), scheduleIdRaw: p.scheduleId }
        );
    }

    const startDateObj = startDate instanceof Date ? startDate : new Date(startDate);
    const endDateObj = endDate instanceof Date ? endDate : new Date(endDate);
    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime()) || endDateObj.getTime() <= startDateObj.getTime()) {
        throw new Error("Invalid startDate/endDate for persistBooking");
    }

    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const dateYmd = startLocal ? startLocal.slice(0, 10) : "";
    const now = new Date();

    const metaPago = String(
        p.paymentStatus || p.meta?.paymentStatus || PAYMENT_STATUS.NOT_PAID
    ).toUpperCase();

    // CORE-07: explicit status wins. Defaults use Wix-native SSOT EN only.
    // FASE2 (ADR-06): canonical bookingStatus is read FIRST; legacy p.status
    // remains as transitional READ fallback only (EOL 31/12/2026).
    const statusCita = String(
        p.bookingStatus ||
        p.status ||
        (
            metaPago === String(PAYMENT_STATUS.PENDING_PAYMENT).toUpperCase() ||
            metaPago === String(PAYMENT_STATUS.NOT_PAID).toUpperCase() ?
            BOOKING_STATUS.PENDING :
            BOOKING_STATUS.CONFIRMED
        )
    );

    let normalizedMeta = p.meta || {};
    if (typeof normalizedMeta === "string") {
        try { normalizedMeta = JSON.parse(normalizedMeta); } catch (_) { normalizedMeta = {}; }
    }
    if (typeof normalizedMeta !== "object" || normalizedMeta === null || Array.isArray(normalizedMeta)) {
        normalizedMeta = {};
    }
    normalizedMeta = { ...normalizedMeta, bookingStatus: statusCita, paymentStatus: metaPago };

    const doc = {
        bookingId: String(bookingId),
        pairToken: String(p.pairToken || normalizedMeta.pairToken || ""),
        revision: Number(p.revision) || 1,
        serviceId: String(serviceId),
        scheduleId: scheduleIdClean,
        resourceId: String(resourceId),
        startDate: startDateObj,
        endDate: endDateObj,
        dateYmd,
        bookingType: normalizeBookingType(p.tipo || p.bookingType),
        // FASE2 (ADR-06): write ONLY the canonical physical field. The legacy
        // "status" key is no longer persisted; reads tolerate it until EOL.
        [BOOKING_FIELDS.STATUS]: statusCita,
        paymentStatus: metaPago,
        meta: normalizedMeta,
        contactDetails: p.contactDetails || {},
        traceId: String(traceId || ""),
        _createdDate: now,
        _updatedDate: now,
    };

    if (isDualBookingType(doc.bookingType) && !doc.pairToken) {
        throw new Error("Missing pairToken for linked booking");
    }

    const existing = await wixData
        .query(CITAS_COL)
        .eq("bookingId", String(bookingId))
        .limit(1)
        .find({ suppressAuth: true, suppressHooks: true })
        .catch(() => null);

    if (existing?.items?.length > 0) {
        const existingDoc = existing.items[0];
        const incomingRevision = Number(doc.revision) || 1;
        const currentRevision = Number(existingDoc.revision) || 1;
        if (incomingRevision < currentRevision) {
            throw new BookingError(ERROR_CODES.DATABASE_ERROR, "Booking revision conflict", {
                bookingId: String(bookingId),
                currentRevision,
                incomingRevision,
            });
        }
        const updated = { ...existingDoc, ...doc };
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;
        const item = await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { created: false, item };
    }

    const item = await wixData.insert(CITAS_COL, doc, { suppressAuth: true, suppressHooks: true });
    return { created: true, item };
}

// =============================================================================
// BLOQUE 12 - ACTUALIZACION SEGURA DE CITA
// =============================================================================

export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
    const bid = _safeTrim(bookingId);
    if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };

    try {
        const res = await wixData
            .query(CITAS_COL)
            .eq("bookingId", bid)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true });

        const cita = res?.items?.[0];
        if (!cita) {
            log.warn("_updateCitaSafe: cita not found", { bookingId: bid, operation, traceId });
            return { updated: false, reason: "NOT_FOUND" };
        }

        const updated = updater(cita);
        if (!updated) return { updated: false, reason: "NO_CHANGE" };

        updated._updatedDate = new Date();
        updated.traceId = traceId || updated.traceId;

        await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { updated: true, bookingId: bid };
    } catch (err) {
        log.error("_updateCitaSafe failed", {
            bookingId: bid,
            operation,
            traceId,
            error: err?.message,
        });
        return { updated: false, reason: "ERROR", error: err?.message };
    }
}

// =============================================================================
// BLOQUE 15 - EXTRACCION DE RESOURCEIDS DESDE SLOTS (CORE-01)
// =============================================================================

/**
 * CORE-01: Paridad 1:1 con reservas.web._getResourceIdsFromSlot.
 * Acepta las cuatro variantes de tipo de recurso que Wix devuelve segun
 * version de API y forma del slot:
 *   group.resourceTypeId | group.resourceType.id | group.resourceType._id |
 *   group.typeId
 * Y las tres variantes de id de recurso:
 *   resource.id | resource._id | resource.resourceId
 * Fallback final: resource directo o resourceId plano en el slot.
 */
export function _extractResourceIdsFromSlot(slot) {
    // v5010.4 (FASE 2): delegacion total en bookingUtils.getResourceIdsFromSlot
    // (unica implementacion; reservas.web importa el mismo helper). Cero 1:1.
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 17 - VERIFICACION DE CONTIGUIDAD/GAP ENTRE SLOTS
// =============================================================================

export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;
    // SSOT: cuando el llamador no fija limite explicito, la tolerancia canonica
    // es SLOT_SEARCH.MINUTOS_TOLERANCIA (BIBLIA 3.2.1 f12), no un magic number.
    const fallbackTolerance = Number(SLOT_SEARCH?.MINUTOS_TOLERANCIA);
    const maxGap = maxGapMinutes == null ?
        (Number.isFinite(fallbackTolerance) ? fallbackTolerance : 120) :
        maxGapMinutes;
    const end1 = slot1.localEndDate || slot1.endDate;
    const start2 = slot2.localStartDate || slot2.startDate;
    if (!end1 || !start2) return false;

    const end1Utc = end1 instanceof Date ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
    const start2Utc = start2 instanceof Date ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
    if (!end1Utc || !start2Utc) return false;

    const rawDiffMinutes = (start2Utc.getTime() - end1Utc.getTime()) / 60000;

    if (rawDiffMinutes < -1) return false;

    const gapMinutes = computeGapMinutes(end1Utc, start2Utc);

    return gapMinutes <= maxGap;
}

// =============================================================================
// BLOQUE 18 - PROYECCION DE SLOTS CERTIFICADOS Y WRITER (CORE-03, CORE-04)
// =============================================================================

/**
 * CORE-04: locationId validado contra SDK_CONFIG.LOCATION_ID.
 * - Slot con otra ubicacion  -> null (fail-fast, nunca sustitucion silenciosa).
 * - Sin ubicacion util o sin GUID -> null.
 */
export function _projectCertifiedSlot(slot, resourceId) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) return null;

    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || slot.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const localStartDate = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
    const localEndDate = _normalizeLocalIsoStr(slot.localEndDate || slot.endDate);

    if (!localStartDate || !localEndDate) return null;

    const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    const endDateUtc = getUtcDateFromMadridLocal(localEndDate);

    if (!startDateUtc || !endDateUtc || endDateUtc.getTime() <= startDateUtc.getTime()) return null;

    // CORE-04: validacion de ubicacion.
    const slotLocationId = _safeTrim(slot.location?.id);

    if (
        slotLocationId &&
        CONFIGURED_LOCATION_ID &&
        slotLocationId !== CONFIGURED_LOCATION_ID
    ) {
        log.warn("_projectCertifiedSlot: slot location does not match configured location", {
            slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId,
        });
        return null;
    }

    const locationId = slotLocationId || CONFIGURED_LOCATION_ID;

    if (!locationId || !_looksLikeGuid(locationId)) {
        log.warn("_projectCertifiedSlot: missing or invalid locationId", {
            slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId,
        });
        return null;
    }

    return {
        serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(slot.scheduleId || slot.slot?.scheduleId || ""),
        localStartDate,
        localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: slot.bookable === true,
        availableResources: _extractResourceIdsFromSlot(slot),
        timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
        locationId,
        locationName: _safeTrim(slot.location?.name || ""),
        formattedAddress: _safeTrim(slot.location?.formattedAddress || ""),
    };
}

/**
 * CORE-03: el Writer V2 exige scheduleId GUID valido (BIBLIA 2.2.1 fila 4).
 * Cascada: projected -> slot -> slot.slot. Si no hay scheduleId util,
 * devuelve null EN VEZ de proyectar scheduleId: "".
 */
export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    const projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;

    const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

    const scheduleId = _safeTrim(
        projected.scheduleId ||
        slot.scheduleId ||
        slot.slot?.scheduleId
    );

    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.warn("_projectWriterSlotFromAvailability: missing or invalid scheduleId", {
            serviceId: finalServiceId,
            scheduleIdRaw: projected.scheduleId || null,
        });
        return null;
    }

    let writerLocationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER);
    if (writerLocationType === "BUSINESS" || !writerLocationType) writerLocationType = "OWNER_BUSINESS";

    const writerSlot = {
        serviceId: finalServiceId,
        scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: {
            id: projected.resourceId,
        },
        location: {
            id: projected.locationId,
            locationType: writerLocationType,
        },
    };

    // CORE-02: propagar addOnOptions si el slot certificado los porta.
    const addOnIds = _extractAddonIdsFromSlot(slot);
    if (addOnIds.length > 0) {
        writerSlot.addOnIds = addOnIds.slice();
        writerSlot.selectedAddOns = addOnIds.slice();
    }

    return writerSlot;
}

// =============================================================================
// BLOQUE 20 - PAIR TOKEN CANONICO COMPARTIDO (CORE-05)
// =============================================================================

/**
 * CORE-05: UNICA fuente de verdad de la huella del par dual.
 *
 * v5010.4 (FASE 2): la definicion canonica vive en bookingUtils.js (capa de
 * utilidades puras; precedencia mmUtils > bookingUtils > core > web). Este
 * modulo la importa y la reexporta como superficie publica historica, sin
 * duplicar logica y sin ciclo de imports.
 *
 * IMPORTANTE: esta huella debe ser IDENTICA en los tres puntos donde se
 * genera o consume un pairToken:
 *   1. reservas.web._getCertifiedDualSlotsInternal  (emisor en disponibilidad)
 *   2. bookingSaga._resolveUnifiedPairToken          (consumidor/reemisor)
 *   3. DualSlotCache.pairToken                       (persistencia)
 *
 * Cualquier cambio en el orden o contenido de los campos rompe la
 * correlacion y la idempotencia. Los 8 campos son obligatorios por
 * contrato (los opcionales se serializan como cadena vacia).
 */
export function _buildPairTokenDeterministic(input) {
    return _hashKey(_buildPairFingerprint(input || {}));
}

// =============================================================================
// BLOQUE 21 - RANKING DE RECURSOS POR CARGA (CORE-07)
// =============================================================================

// CORE-07 v5010.5: unico alias de dominio permitido (grafia del SSOT
// espanol; BIBLIA 3.2.1). El equivalente en ingles ("CANCELED") NO es un
// alias aqui: los ESTADOS de reserva ya estan cubiertos por
// INACTIVE_BOOKING_STATUSES (lista canonica: CANCELLED, DECLINED, REJECTED,
// NOSHOW). En cambio, los PAGOS no tienen enum canonicode cancelacion en
// Payments ignored for staff load ranking (Wix-native SSOT only).
export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    const input = Array.isArray(resourceIds) ?
        Array.from(new Set(resourceIds.map((id) => _safeTrim(id)).filter(_looksLikeGuid))) : [];

    if (input.length < 2) return input;

    const day = _safeTrim(dateYmd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        log.warn("_rankResourcesByLoad: invalid dateYmd", { dateYmd: day, traceId });
        return input;
    }

    const loads = Object.fromEntries(input.map((id, index) => [id, {
        resourceId: id,
        load: 0,
        firstIndex: index,
    }]));

    // CORE-07: defensa ante INACTIVE_BOOKING_STATUSES ausente o no-array
    // (p. ej. durante la migracion a ESTADOS_CITA_INACTIVOS).
    const inactiveList = Array.isArray(INACTIVE_BOOKING_STATUSES) ?
        INACTIVE_BOOKING_STATUSES.map((s) => String(s || "").toUpperCase()).filter(Boolean) :
        [];

    try {
        const pageSize = 1000;
        let skip = 0;
        let hasMore = true;

        while (hasMore) {
            const result = await wixData
                .query(CITAS_COL)
                .eq("dateYmd", day)
                .in("resourceId", input)
                .limit(pageSize)
                .skip(skip)
                .find({ suppressAuth: true, consistentRead: true });

            const items = Array.isArray(result?.items) ? result.items : [];

            for (const item of items) {
                const resourceId = _safeTrim(item?.resourceId);
                if (!loads[resourceId]) continue;

                // CORE-07: tolerancia bookingStatus (canonico V20) || status.
                const status = String(item?.bookingStatus || item?.status || "").toUpperCase();
                const paymentStatus = String(item?.paymentStatus || "").toUpperCase();

                const cancelled =
                    inactiveList.indexOf(status) >= 0;
                const ignoredPayment =
                    paymentStatus === String(PAYMENT_STATUS.REFUNDED).toUpperCase() ||
                    paymentStatus === String(PAYMENT_STATUS.PARTIALLY_REFUNDED).toUpperCase();

                if (!cancelled && !ignoredPayment) loads[resourceId].load += 1;
            }

            skip += items.length;
            hasMore = items.length === pageSize;
            if (!items.length) hasMore = false;
        }

        return Object.values(loads)
            .sort((a, b) => a.load - b.load || a.firstIndex - b.firstIndex)
            .map((entry) => entry.resourceId);
    } catch (error) {
        log.warn("_rankResourcesByLoad failed; preserving availability order", {
            traceId,
            dateYmd: day,
            error: error?.message,
        });
        return input;
    }
}