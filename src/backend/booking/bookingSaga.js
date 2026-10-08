/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5009-FISCAL-V20.4-SAGA
BASE: v5009-FISCAL-V20.2 + Afinado final contra BIBLIA v4
SSOT: SSOT CONSOLIDADO v5002.6 | BIBLIA v5009-V20-FINAL-CONSOLIDATED-v4
MISSION: Orquestador transaccional. Saga compensable para reservas simples
         y duales con gap de exposicion. Gestiona locks, heartbeat,
         idempotencia triple capa y creacion SECUENCIAL F1 -> F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).

FIXES APLICADOS v5009-FISCAL-V20.3:
  - SAGA-01: skipAvailabilityValidation = false (BIBLIA 2.2 regla 7:
             "no desactivar nativo"). Wix re-valida disponibilidad real.
  - SAGA-02: pairToken UNIFICADO. Prioridad absoluta al token emitido por
             reservas.web.getCertifiedDualSlots. Fallback dual determinista
             con la MISMA huella (_buildPairFingerprint, unica definicion en
             bookingUtils y reexportada por bookingCore; sin copia local).
             Fallback simple por _resolveStablePairToken.
  - SAGA-03: OWNER_BUSINESS GARANTIZADO. Resolucion de locationId con
             cascada (slot validado -> catalogo) + _assertPristineSlotContract
             que BLOQUEA la creacion si el slot no cumple BIBLIA 2.2.1.
  - SAGA-04: Addons inyectados (addOnIds) en bookedEntity.slot de F1 y F2,
             con validacion de limite BIBLIA 3.2 (MAX_POR_RESERVA = 5).
  - SAGA-05: PAYMENT_STATUS.NOT_PAID en confirmOrDecline (sin literales).
  - SAGA-06: Compensacion NO cancela reservas CONFIRMED/CANCELLED/REFUNDED.
             Compara contra enum nativo Wix Y valor SSOT espanol (BIBLIA
             3.2.1: CONFIRMED -> CONFIRMADO, CANCELLED -> CANCELADO).
  - SAGA-07: Constantes de configuracion V20 canonicas (BIBLIA 3.2.1
             f13/f15/f16: MS_TTL_MUTEX, MS_LATIDO, MINUTOS_MAX_HUECO_DUAL).
             v5010.4 FASE 2: cascadas legacy eliminadas; internalConfig ya
             solo expone los nombres V20.
  - SAGA-08: availableStaff se lee exclusivamente desde el campo canónico.
  - SAGA-09: selectedPaymentOption ONLINE en create cuando path eCom.

NOTA CONTRACTUAL (BIBLIA 2.2.1):
  bookedEntity.slot.serviceId      -> GUID servicio
  bookedEntity.slot.scheduleId     -> GUID schedule (obligatorio)
  bookedEntity.slot.startDate      -> ISO UTC con Z
  bookedEntity.slot.endDate        -> ISO UTC con Z
  bookedEntity.slot.timezone       -> Europe/Madrid
  bookedEntity.slot.resource.id    -> GUID recurso
  bookedEntity.slot.location       -> { id, locationType: OWNER_BUSINESS }
  contactDetails                   -> objeto contacto
  totalParticipants                -> 1
=============================================================================
*/

import { bookings } from "@wix/bookings";
import { elevate } from "@wix/sdk";
// EXCEPCION DATA API (APENDICE C de la BIBLIA): persistencia CMS server-side
// con suppressAuth/suppressHooks; ver apendice antes de proponer migracion.
import wixData from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONCURRENCY,
    SDK_CONFIG,
    SLOT_SEARCH,
    BOOKING_STATUS,
    BOOKING_TYPE,
    PAYMENT_STATUS,
    PAYMENT_METHOD,
    COMPENSATION_KIND,
    COMPENSATION_STATUS,
    APP_IDS,
    BOOKING_FIELDS,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    _stableSerialize,
    _hashKey,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _normalizeLocalIsoStr,
    _executeWithRetry,
    withTimeout,
} from "public/mmUtils";

import {
    computeGapMinutes,
    cleanGuidList,
} from "backend/booking/bookingUtils";

import { logger } from "backend/logger";

import {
    cancelBookingElevated,
    confirmOrDeclineBookingElevated,
    createCheckoutElevated,
    getCheckoutUrlElevated,
    _lockSlotKeyOrFail,
    _unlockSlotKey,
    _renewLock,
    _initTransaction,
    _completeTransaction,
    _failTransaction,
    _persistBooking,
    _forceStaffInPristineSlot,
    _resolveScheduleIdForResource,
    _buildLockKeys,
    createBookingError,
    normalizeError,
    ERROR_CODES,
    _extractCheckoutId,
    // v5010.4 (FASE 2 / CORE-05): huella canonica UNICA (definida en
    // bookingUtils, reexportada por bookingCore). SAGA-02 la consume para
    // que el token FINGERPRINT coincida 1:1 con el emitido por
    // reservas.web._getCertifiedDualSlotsInternal. Sin copia local.
    _buildPairFingerprint,
} from "backend/booking/bookingCore";

export { _extractCheckoutId };

import {
    _resolveServiceIdInternal,
    _invalidateCachesInternal,
    _getServiceBySlugOrIdInternal,
    _resolveStaffForSlotInternal,
} from "backend/reservas.web.js";

const log = logger;

// =============================================================================
// CONSTANTES (SAGA-07: tolerantes al renombrado V20, BIBLIA 3.2.1)
// =============================================================================

// v5010.4 (FASE 2): SSOT renombrado a V20 (BIBLIA 3.2.1 f15/f16); cascada
// legacy eliminada porque internalConfig ya no expone los nombres ingleses.
const LOCKTTLMS = Number(CONCURRENCY?.MS_TTL_MUTEX) || 300000;

const HEARTBEATMS = Number(CONCURRENCY?.MS_LATIDO) || 15000;

const CITASCOL = BUSINESS_COLLECTIONS.CITAS_F2;
const SERVICIOSCOL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
// FASE4 (ADR-05): CompensacionesPendientes absorbida en ControlOperativo.
const COMPENSACIONESCOL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

// v5010.4 (FASE 2): clave V20 segun BIBLIA 3.2.1 f13; cascada legacy
// eliminada (internalConfig ya no expone MAX_DUAL_GAP_MINUTES).
const MINUTOS_MAX_HUECO_DUAL = Math.max(
    0,
    Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL) || 120
);

const BOOKING_CREATION_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.BOOKING_CREATION_MS) || 25000;
const CHECKOUT_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.CHECKOUT_MS) || 20000;
const API_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

// BIBLIA 3.2 fila 10: BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA = 5
const MAX_ADDONS_PER_BOOKING = 5;

// SAGA-01: BIBLIA 2.2 regla 7 -> no desactivar la validacion nativa de Wix.
const SKIP_AVAILABILITY_VALIDATION = false;

// SAGA-05: SSOT = Wix native EN enums only (no ES cascade).
const PAYMENT_STATUS_NOT_PAID = _safeTrim(PAYMENT_STATUS.NOT_PAID);
const PAYMENT_STATUS_PENDING = _safeTrim(PAYMENT_STATUS.PENDING_PAYMENT);
const BOOKING_STATUS_CONFIRMED = _safeTrim(BOOKING_STATUS.CONFIRMED);
const BOOKING_STATUS_PENDING_PAYMENT = _safeTrim(
    BOOKING_STATUS.PENDING || BOOKING_STATUS.PENDING_PAYMENT
);

// SAGA-06: non-cancelable = Wix native booking statuses only.
const NON_CANCELABLE_STATUSES = new Set(
    [
        BOOKING_STATUS.CONFIRMED,
        BOOKING_STATUS.CANCELED,
        BOOKING_STATUS.REFUNDED,
        BOOKING_STATUS.DECLINED,
        "DONE",
        "COMPLETE",
    ]
    .map(function (v) { return _safeTrim(v).toUpperCase(); })
    .filter(Boolean)
);

// =============================================================================
// BLOCK 1 - PAIR TOKEN UNIFICADO (SAGA-02)
// =============================================================================

// v5010.4 (FASE 2): la copia local de _buildPairFingerprint fue ELIMINADA.
// Unica fuente de verdad: bookingUtils._buildPairFingerprint, consumida aqui
// via re-export de bookingCore (ver import arriba). Esto elimina el riesgo
// normativo de divergencia silenciosa de huella entre saga y disponibilidad
// (CORE-05 / SAGA-02).

function _resolveStablePairToken({ serviceId, resourceId, f1Start, f2Start, email }) {
    const emailHash = _hashKey(_safeTrim(email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(serviceId),
        resourceId: _safeTrim(resourceId),
        f1Start: _safeTrim(f1Start),
        f2Start: _safeTrim(f2Start || ""),
    });
    const hash = _hashKey(payload + "|" + emailHash);
    return "pt_" + hash.slice(0, 32);
}

/**
 * SAGA-02: Resolucion unificada de pairToken.
 *
 * Prioridad:
 *   1. SUPPLIED       -> token emitido por getCertifiedDualSlots / frontend.
 *                        Es la unica via que garantiza correlacion exacta.
 *   2. FINGERPRINT    -> dual con resourceId explicito: misma huella que
 *                        reservas.web, por lo que el token coincide.
 *   3. STABLE         -> simple, o dual sin resourceId (degradado, con warn).
 */
function _resolveUnifiedPairToken({
    suppliedPairToken,
    isDual,
    serviceId,
    linkedPhases,
    f1Start,
    f1End,
    f2Start,
    f2End,
    resourceId,
    email,
    traceId,
}) {
    const supplied = _safeTrim(suppliedPairToken);
    if (supplied) {
        return { pairToken: supplied, source: "SUPPLIED" };
    }

    if (isDual && _looksLikeGuid(resourceId)) {
        const fingerprint = _buildPairFingerprint({
            serviceId: serviceId,
            linkedPhases: linkedPhases,
            dateYmd: _safeTrim(f1Start).slice(0, 10),
            f1Start: f1Start,
            f1End: f1End,
            f2Start: f2Start,
            f2End: f2End,
            resourceId: resourceId,
        });
        return { pairToken: _hashKey(fingerprint), source: "FINGERPRINT" };
    }

    if (isDual) {
        log.warn(
            "SAGA-02: dual booking without supplied pairToken and without explicit " +
            "resourceId. Falling back to STABLE token (includes email hash), which " +
            "will NOT match getCertifiedDualSlots output. Frontend must forward " +
            "the pairToken returned by the availability query.", { traceId: traceId, serviceId: serviceId }
        );
    }

    return {
        pairToken: _resolveStablePairToken({
            serviceId: serviceId,
            resourceId: resourceId,
            f1Start: f1Start,
            f2Start: f2Start,
            email: email,
        }),
        source: isDual ? "STABLE_DEGRADED" : "STABLE",
    };
}

// =============================================================================
// BLOCK 2 - PERSISTED META NORMALIZATION
// =============================================================================

export function _normalizePersistedMeta(meta) {
    if (!meta) return {};

    try {
        if (typeof meta === "string") {
            const parsed = JSON.parse(meta);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
                parsed :
                {};
        }

        return typeof meta === "object" && !Array.isArray(meta) ?
            meta :
            {};
    } catch (_) {
        return {};
    }
}

// =============================================================================
// BLOCK 3 - UTILIDADES
// =============================================================================

function _isGuidOrNull(value) {
    const v = _safeTrim(value);
    if (!v) return null;
    return _looksLikeGuid(v) ? v : null;
}

async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
    for (const key of lockKeys || []) {
        try {
            await _unlockSlotKey(key, lockOwnerId);
        } catch (e) {
            log.warn("_bestEffortUnlockAll: failed to unlock", {
                key: key,
                error: e?.message,
            });
        }
    }
}

// =============================================================================
// BLOCK 4 - BOOKING COMPENSATION (SAGA-06)
// =============================================================================

async function _compensateCreatedBookings(createdBookings, traceId) {
    for (const booking of createdBookings || []) {
        const bookingId = booking?.bookingId || booking?.id;
        if (!bookingId) continue;

        // FASE2 (ADR-06): lectura canonica bookingStatus PRIMERO; el legado
        // "status" queda como fallback de LECTURA transitorio (EOL 31/12/2026).
        const status = _safeTrim(booking?.[BOOKING_FIELDS.STATUS] || booking?.status).toUpperCase();

        // SAGA-06: nunca cancelar una reserva ya confirmada, cancelada o
        // reembolsada. Cancelar un CONFIRMED genera descuadre fiscal y de caja.
        if (status && NON_CANCELABLE_STATUSES.has(status)) {
            log.warn("Skipping compensation for non-cancelable booking", {
                bookingId: bookingId,
                status: status,
                phase: booking?.phase || null,
                traceId: traceId,
            });
            continue;
        }

        try {
            await _executeWithRetry(
                () =>
                withTimeout(
                    () => cancelBookingElevated(bookingId, { suppressAuth: true }),
                    API_TIMEOUT_MS,
                    "cancelBookingCompensation"
                ),
                2,
                300
            );
            log.info("Compensated booking cancelled", {
                bookingId: bookingId,
                traceId: traceId,
            });
        } catch (cancelErr) {
            log.error("Compensation cancel failed; queuing", {
                bookingId: bookingId,
                traceId: traceId,
                error: cancelErr?.message,
            });
            try {
                await wixData.insert(
                    COMPENSACIONESCOL, {
                        id: "COMP_" + bookingId + "_" + Date.now(),
                        kind: COMPENSATION_KIND.CANCEL_BOOKING,
                        compensationKind: COMPENSATION_KIND.CANCEL_BOOKING,
                        bookingId: bookingId,
                        phase: booking?.phase || "UNKNOWN",
                        status: COMPENSATION_STATUS.PENDING,
                        compensationStatus: COMPENSATION_STATUS.PENDING,
                        attempts: 0,
                        // v5010.7 SSOT: solo campos canonicos internos.
                        // Alias legacy amount/concept eliminados (cero
                        // lectores verificados por grep en src/).
                        totalAmount: 0,
                        paymentMethod: null,
                        transactionId: null,
                        orderId: null,
                        refundId: null,
                        operationDescription: "Booking compensation after saga failure",
                        movementType: null,
                        alertRequired: true,
                        lastError: cancelErr?.message || "UNKNOWN",
                        traceId: traceId,
                        _createdDate: new Date(),
                        _updatedDate: new Date(),
                    }, { suppressAuth: true }
                );
            } catch (queueErr) {
                log.error("Failed to queue compensation", {
                    bookingId: bookingId,
                    traceId: traceId,
                    error: queueErr?.message,
                });
            }
        }
    }
}

// =============================================================================
// BLOCK 5 - SELECTIVE ELEVATION + TIMEOUT (FIX-37)
// =============================================================================

async function _createBookingWithSelectiveElevation(booking, options, traceId) {
    try {
        return await withTimeout(
            () => bookings.createBooking(booking, options),
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking"
        );
    } catch (err) {
        const code = _safeTrim(
            err?.code || err?.details?.applicationError?.code
        ).toUpperCase();
        const isAccessDenied =
            code === "ACCESS_DENIED" ||
            String(err?.message || "").toUpperCase().includes("ACCESS_DENIED");
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await withTimeout(
            () => elevate(bookings.createBooking)(booking, options),
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking:elevated"
        );
    }
}

// =============================================================================
// BLOCK 6 - VALIDACION DEFENSIVA DE RESPUESTA (FIX-42)
// =============================================================================

function _validateCreateBookingResponse(booking, phase, traceId) {
    const id = _safeTrim(booking?.id || booking?._id);
    if (!id || !_looksLikeGuid(id)) {
        log.error("CreateBooking returned invalid booking", {
            phase,
            traceId,
            hasId: Boolean(booking?.id),
            has_id: Boolean(booking?._id),
        });
        throw createBookingError(
            ERROR_CODES.BOOKING_CREATION_FAILED,
            "Booking " + phase + " created but no valid ID returned", { traceId, phase }
        );
    }

    const revisionRaw = booking?.revision ?? booking?.revisionNumber ?? null;
    const revisionNum = Number(revisionRaw);
    const revision =
        Number.isFinite(revisionNum) && revisionNum > 0 ? revisionNum : null;

    if (revision === null) {
        log.warn("CreateBooking returned no revision; defaulting to 1 in CitasF2", {
            phase,
            traceId,
            bookingId: id,
        });
    }

    return {
        bookingId: id,
        revision,
        status: _safeTrim(booking?.status) || null,
    };
}

// =============================================================================
// BLOCK 7 - DETECCION DE FLAG DOUBLEBOOKED (FIX-38)
// =============================================================================

function _checkDoubleBookingFlag(booking, phase, traceId) {
    if (booking?.doubleBooked === true) {
        log.warn("DOUBLE_BOOKING_DETECTED", {
            phase,
            traceId,
            bookingId: booking?.id || booking?._id,
        });
        return true;
    }
    return false;
}

// =============================================================================
// BLOCK 8 - VALIDACION EXPLICITA DE GAP MAXIMO (FIX-34)
// =============================================================================

function _validateDualGap(f1LocalEnd, f2LocalStart, traceId) {
    const f1EndLocal = _normalizeLocalIsoStr(f1LocalEnd);
    const f2StartLocal = _normalizeLocalIsoStr(f2LocalStart);

    if (!f1EndLocal || !f2StartLocal) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: invalid dates", { traceId, f1LocalEnd, f2LocalStart }
        );
    }

    const f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
    const f2StartUtc = getUtcDateFromMadridLocal(f2StartLocal);

    if (!f1EndUtc || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: could not convert to UTC", { traceId, f1EndLocal, f2StartLocal }
        );
    }

    const rawDiffMinutes =
        (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;

    if (rawDiffMinutes < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: F2 starts before F1 ends (" +
            rawDiffMinutes.toFixed(2) + " min)", { traceId, gapMinutes: rawDiffMinutes }
        );
    }

    const gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);

    if (gapMinutes > MINUTOS_MAX_HUECO_DUAL) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: gap " + gapMinutes.toFixed(2) +
            " min exceeds MAX (" + MINUTOS_MAX_HUECO_DUAL + ")", { traceId, gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL }
        );
    }

    return { gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL };
}

// =============================================================================
// BLOCK 9 - VALIDACION DEL SERVICIO F2 (FIX-32, FIX-36, SAGA-08)
// =============================================================================

async function _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId) {
    const linkedServiceId = _safeTrim(linkedPhases);
    if (!linkedServiceId || !_looksLikeGuid(linkedServiceId)) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service: invalid GUID", { traceId, linkedPhases: linkedServiceId }
        );
    }

    const res = await wixData
        .query(SERVICIOSCOL)
        .eq("serviceId", linkedServiceId)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(function () { return { items: [] }; });

    const service = res?.items?.[0] || null;
    if (!service) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " not found in catalog", { traceId }
        );
    }

    // BIBLIA 4.3 fila 20 + v5010.7 CERO LEGACY: unico campo canonic del
    // catalogo V20 es clientHidden. Aliases hidden/hiddenCliente eliminados.
    const isHidden = service.clientHidden === true;

    if (isHidden) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " is hidden", { traceId }
        );
    }

    const serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " is not APPOINTMENT (type=" + serviceType + ")", { traceId }
        );
    }

    const phase2Duration = Number(
        service.phase2Duration ||
        service.totalDuration ||
        service.phase1Duration ||
        0
    );
    if (phase2Duration <= 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has invalid duration (" + phase2Duration + ")", { traceId }
        );
    }

    const availableStaff = cleanGuidList(service.availableStaff || []);
    if (availableStaff.length === 0) {
        throw createBookingError(
            ERROR_CODES.STAFF_UNAVAILABLE,
            "Linked phase service " + linkedServiceId + " has no available staff", { traceId }
        );
    }

    const parentLoc = _safeTrim(parentLocationId);
    const f2Loc = _safeTrim(service.locationId || service.location);
    if (parentLoc && f2Loc && _looksLikeGuid(parentLoc) && _looksLikeGuid(f2Loc) &&
        parentLoc !== f2Loc) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has incompatible locationId (" + f2Loc + " != " + parentLoc + ")", { traceId }
        );
    }

    return { service, phase2Duration, availableStaff };
}

// =============================================================================
// BLOCK 10 - COMPENSACION DE PERSISTENCIA CMS
// =============================================================================

async function _deleteCitasByPairToken(pairToken, traceId) {
    const token = _safeTrim(pairToken);
    if (!token) return;

    try {
        const res = await wixData
            .query(CITASCOL)
            .eq("pairToken", token)
            .limit(10)
            .find({ suppressAuth: true, suppressHooks: true });

        const items = res?.items || [];
        for (const item of items) {
            try {
                await wixData.remove(CITASCOL, item._id, {
                    suppressAuth: true,
                    suppressHooks: true,
                });
                log.info("Compensated CitaF2 removal", {
                    citaId: item._id,
                    bookingId: item.bookingId,
                    traceId,
                });
            } catch (removeErr) {
                log.error("Failed to remove CitaF2 during compensation", {
                    citaId: item._id,
                    traceId,
                    error: removeErr?.message,
                });
            }
        }
    } catch (err) {
        log.error("_deleteCitasByPairToken failed", {
            pairToken: token,
            traceId,
            error: err?.message,
        });
    }
}

// =============================================================================
// BLOCK 11 - ADDONS (FIX-35 + SAGA-04)
// =============================================================================

function _detectAddons(unsafePayload, metaCita, serviceConfig, traceId) {
    const rawAddons =
        unsafePayload?.nativeAddonIds ||
        unsafePayload?.addOnIds ||
        unsafePayload?.addOnIds ||
        metaCita?.nativeAddonIds ||
        metaCita?.addOnIds ||
        metaCita?.addOnIds || [];

    const requested = Array.isArray(rawAddons) ?
        rawAddons
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); }) :
        [];

    const unique = Array.from(new Set(requested));

    // SAGA-04: limite BIBLIA 3.2 fila 10 (MAX_POR_RESERVA = 5).
    if (unique.length > MAX_ADDONS_PER_BOOKING) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Too many addOnOptions requested (" + unique.length +
            "). Maximum allowed is " + MAX_ADDONS_PER_BOOKING + ".", { traceId, addonCount: unique.length, max: MAX_ADDONS_PER_BOOKING }
        );
    }

    // Solo se envian a Wix los addOnOptions que existen en el catalogo del servicio.
    const catalogAddons = Array.isArray(serviceConfig?.metadata?.addOnOptions) ?
        serviceConfig.metadata.addOnOptions :
        [];

    let validated = unique;
    if (unique.length > 0 && catalogAddons.length > 0) {
        const allowed = new Set(
            catalogAddons
            .map(function (a) {
                return [
                    _safeTrim(a?.nativeId),
                    _safeTrim(a?.id),
                ].filter(Boolean);
            })
            .flat()
        );
        validated = unique.filter(function (id) { return allowed.has(id); });

        if (validated.length !== unique.length) {
            log.warn("SAGA-04: some requested addOnOptions are not in service catalog", {
                traceId,
                requested: unique,
                accepted: validated,
            });
        }
    }

    if (validated.length > 0) {
        log.info("SAGA-04: injecting addOnIds into bookedEntity.slot", {
            traceId,
            addonCount: validated.length,
            addOnIds: validated,
        });
    }

    return validated;
}

/**
 * SAGA-04: campos de addon a fusionar en el slot antes de _forceStaffInPristineSlot.
 * Se exponen ambas claves porque el contrato del Writer V2 ha usado
 * historicamente addOnIds y selectedAddOns.
 */
function _buildAddonSlotFields(addOnIds) {
    if (!Array.isArray(addOnIds) || addOnIds.length === 0) return {};
    return {
        addOnIds: addOnIds.slice(),
        selectedAddOns: addOnIds.slice(),
    };
}

// =============================================================================
// BLOCK 12 - UBICACION OWNER_BUSINESS (SAGA-03)
// =============================================================================

/**
 * SAGA-03: resuelve la ubicacion del booking forzando OWNER_BUSINESS.
 *
 * BIBLIA 2.2.1 fila 8 exige bookedEntity.slot.location.locationType =
 * OWNER_BUSINESS en creacion. La consulta de disponibilidad usa BUSINESS
 * (reservas.web.LOCATION_TS); la creacion usa OWNER_BUSINESS
 * (reservas.web.LOCATION_BOOKING). Aqui se garantiza el segundo.
 *
 * Cascada de resolucion del id:
 *   1. slot F1 validado (lo devolvio Wix)
 *   2. slot F2 validado
 *   3. catalogo del servicio (serviceConfig.locationId)
 *   4. parentLocationId resuelto en fase 0
 */
function _resolveBookingLocation({
    validatedSlotF1,
    validatedSlotF2,
    serviceConfig,
    parentLocationId,
    traceId,
}) {
    const resolvedId =
        _isGuidOrNull(validatedSlotF1?.location?.id) ||
        _isGuidOrNull(validatedSlotF2?.location?.id) ||
        _isGuidOrNull(serviceConfig?.locationId) ||
        _isGuidOrNull(parentLocationId);

    if (!resolvedId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking location is missing. Cannot build OWNER_BUSINESS location.", { traceId }
        );
    }

    const sourceLocationType = _safeTrim(
        validatedSlotF1?.location?.locationType
    ).toUpperCase();

    if (sourceLocationType && sourceLocationType !== "OWNER_BUSINESS") {
        log.info("SAGA-03: overriding locationType for booking creation", {
            traceId,
            from: sourceLocationType,
            to: "OWNER_BUSINESS",
            locationId: resolvedId,
        });
    }

    return Object.freeze({
        id: resolvedId,
        locationType: "OWNER_BUSINESS",
    });
}

/**
 * SAGA-03: guard contractual. Bloquea la creacion si el pristine slot no
 * cumple BIBLIA 2.2.1. Fallar aqui es barato; fallar en Wix deja reservas
 * huerfanas que requieren compensacion.
 */
function _assertPristineSlotContract(pristineSlot, phase, traceId) {
    const startIso = _safeTrim(pristineSlot?.startDate);
    const endIso = _safeTrim(pristineSlot?.endDate);
    const locationType = _safeTrim(pristineSlot?.location?.locationType).toUpperCase();

    const missing = [];

    if (!_isGuidOrNull(pristineSlot?.serviceId)) missing.push("serviceId");
    if (!_isGuidOrNull(pristineSlot?.scheduleId)) missing.push("scheduleId");
    if (!startIso) missing.push("startDate");
    else if (!/Z$/.test(startIso)) missing.push("startDate must be ISO UTC with Z");
    if (!endIso) missing.push("endDate");
    else if (!/Z$/.test(endIso)) missing.push("endDate must be ISO UTC with Z");
    if (!_isGuidOrNull(pristineSlot?.resource?.id)) missing.push("resource.id");
    if (!_isGuidOrNull(pristineSlot?.location?.id)) missing.push("location.id");
    if (locationType !== "OWNER_BUSINESS") {
        missing.push("location.locationType must be OWNER_BUSINESS");
    }

    if (missing.length > 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Pristine slot " + phase + " violates createBooking contract: " +
            missing.join("; "), { traceId, phase, missing }
        );
    }

    return true;
}

// =============================================================================
// BLOCK 13 - SAGA ORCHESTRATOR
// =============================================================================

export class BookingSagaOrchestrator {
    constructor(traceId) {
        this.traceId = traceId;
        this.steps = [];
        this.completedSteps = [];
    }

    addStep(name, executeFn, compensateFn) {
        this.steps.push({
            name: name,
            executeFn: executeFn,
            compensateFn: compensateFn,
        });
    }

    async execute() {
        for (const step of this.steps) {
            try {
                log.info("Saga step: " + step.name, { traceId: this.traceId });
                const result = await step.executeFn();
                this.completedSteps.push(
                    Object.assign({}, step, { result: result })
                );
            } catch (error) {
                log.error("Saga step failed: " + step.name, {
                    traceId: this.traceId,
                    error: error?.message,
                });
                await this._compensate();
                throw error;
            }
        }
        return this.completedSteps.map(function (s) { return s.result; });
    }

    async _compensate() {
        const reversed = [].concat(this.completedSteps).reverse();
        for (const step of reversed) {
            if (step.compensateFn) {
                try {
                    log.info("Saga compensating: " + step.name, {
                        traceId: this.traceId,
                    });
                    await step.compensateFn(step.result);
                } catch (compErr) {
                    log.error("Saga compensation failed: " + step.name, {
                        traceId: this.traceId,
                        error: compErr?.message,
                    });
                }
            }
        }
    }
}

// =============================================================================
// BLOCK 14 - EXECUTE BOOKING SAGA (MAIN FUNCTION)
// =============================================================================

export async function executeBookingSaga(unsafePayload) {
    const traceId = unsafePayload?.traceId || makeTraceId("saga");
    const metaCita = _normalizePersistedMeta(
        unsafePayload?.metaCita || unsafePayload?.meta || {}
    );

    try {
        // =========================================================================
        // PHASE 0: VALIDATION AND RESOLUTION
        // =========================================================================
        const email = _safeTrim(
            unsafePayload?.email ||
            metaCita.email ||
            unsafePayload?.contactDetails?.email
        );
        if (!email) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Email is required", { traceId: traceId }
            );
        }

        const rawServiceId = _safeTrim(
            unsafePayload?.serviceId || metaCita.serviceId || ""
        );
        const serviceId = await _resolveServiceIdInternal(rawServiceId);
        if (!serviceId || !_looksLikeGuid(serviceId)) {
            throw createBookingError(
                ERROR_CODES.SERVICE_NOT_FOUND,
                "Service not found", { traceId: traceId, rawServiceId: rawServiceId }
            );
        }

        const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
        const serviceConfig = serviceRes?.data || {};
        const isDual =
            serviceConfig.allowCombine === true &&
            !!serviceConfig.linkedPhases &&
            _looksLikeGuid(serviceConfig.linkedPhases);
        const linkedPhases = isDual ? serviceConfig.linkedPhases : null;
        const parentLocationId = _safeTrim(
            serviceConfig.locationId || serviceConfig.location
        );

        const requestedResourceId = _safeTrim(
            unsafePayload?.resourceId || metaCita.resourceId
        );
        const slotF1Input = unsafePayload?.slotF1 || {};
        const slotF2Input = unsafePayload?.slotF2 || {};

        const f1LocalStart = _normalizeLocalIsoStr(
            slotF1Input.localStartDate || slotF1Input.start || metaCita.f1Start
        );
        const f1LocalEnd = _normalizeLocalIsoStr(
            slotF1Input.localEndDate || slotF1Input.end || metaCita.f1End
        );

        if (!f1LocalStart || !f1LocalEnd) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "F1 slot dates are required", { traceId: traceId }
            );
        }

        let f2LocalStart = "";
        let f2LocalEnd = "";

        if (isDual) {
            f2LocalStart = _normalizeLocalIsoStr(
                slotF2Input.localStartDate || slotF2Input.start || metaCita.f2Start
            );
            f2LocalEnd = _normalizeLocalIsoStr(
                slotF2Input.localEndDate || slotF2Input.end || metaCita.f2End
            );

            const linkedValidation = await _validateLinkedPhaseService(
                linkedPhases,
                parentLocationId,
                traceId
            );

            if (!f2LocalStart) {
                const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
                if (!f1EndUtc) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_DATES,
                        "Could not compute F1 end UTC for F2 derivation", { traceId }
                    );
                }
                const exposureMs =
                    Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
                const linkedPhase2Ms =
                    Math.max(0, Number(linkedValidation.phase2Duration || 30)) * 60 * 1000;
                const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                const f2EndUtc = new Date(f2StartUtc.getTime() + linkedPhase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }

            _validateDualGap(f1LocalEnd, f2LocalStart, traceId);
        }

        // SAGA-04: addOnOptions detectados y validados contra catalogo del servicio.
        const detectedAddonIds = _detectAddons(
            unsafePayload,
            metaCita,
            serviceConfig,
            traceId
        );
        const addonSlotFields = _buildAddonSlotFields(detectedAddonIds);

        // =========================================================================
        // PHASE 1: REAL-TIME REVALIDATION
        // Se ejecuta ANTES de resolver el pairToken definitivo porque la huella
        // dual (SAGA-02) necesita el resourceId final balanceado por el backend
        // de disponibilidad, que solo se conoce tras la revalidacion.
        // =========================================================================
        const resourceValidation = await _resolveStaffForSlotInternal({
            serviceId: serviceId,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: isDual ? f2LocalStart : null,
            f2End: isDual ? f2LocalEnd : null,
            requestedResourceId: requestedResourceId || null,
            addOnIds: detectedAddonIds,
            traceId: traceId,
        });

        if (resourceValidation?.status !== "SUCCESS") {
            throw createBookingError(
                resourceValidation?.error?.code || ERROR_CODES.SLOT_UNAVAILABLE,
                resourceValidation?.error?.message || "Slot no longer available", { traceId: traceId }
            );
        }

        const finalResourceId = resourceValidation.data.resourceId;
        const validatedSlotF1 = resourceValidation.data.slotF1;
        const validatedSlotF2 = resourceValidation.data.slotF2;

        if (isDual && validatedSlotF1 && validatedSlotF2) {
            const f1EndFromValidated = _normalizeLocalIsoStr(
                validatedSlotF1.localEndDate ||
                validatedSlotF1.endDate ||
                f1LocalEnd
            );
            const f2StartFromValidated = _normalizeLocalIsoStr(
                validatedSlotF2.localStartDate ||
                validatedSlotF2.startDate ||
                f2LocalStart
            );
            _validateDualGap(f1EndFromValidated, f2StartFromValidated, traceId);
        }

        // =========================================================================
        // PHASE 2: PAIR TOKEN UNIFICADO (SAGA-02)
        // =========================================================================
        const tokenResolution = _resolveUnifiedPairToken({
            suppliedPairToken: unsafePayload?.pairToken || metaCita.pairToken,
            isDual: isDual,
            serviceId: serviceId,
            linkedPhases: linkedPhases,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: f2LocalStart,
            f2End: f2LocalEnd,
            resourceId: finalResourceId || requestedResourceId,
            email: email,
            traceId: traceId,
        });

        const pairToken = tokenResolution.pairToken;

        log.info("SAGA-02: pairToken resolved", {
            traceId: traceId,
            source: tokenResolution.source,
            isDual: isDual,
            pairToken: pairToken,
        });

        // SAGA-03: ubicacion OWNER_BUSINESS garantizada para la creacion.
        const bookingLocation = _resolveBookingLocation({
            validatedSlotF1: validatedSlotF1,
            validatedSlotF2: validatedSlotF2,
            serviceConfig: serviceConfig,
            parentLocationId: parentLocationId,
            traceId: traceId,
        });

        // =========================================================================
        // PHASE 3: IDEMPOTENCY CHECK ON CITAS_F2
        // =========================================================================
        const existingCitaRes = await wixData
            .query(CITASCOL)
            .eq("pairToken", pairToken)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
            .catch(function () { return { items: [] }; });

        if (existingCitaRes?.items?.length > 0) {
            const existingCita = existingCitaRes.items[0];
            const existingPaymentStatus =
                _safeTrim(existingCita.paymentStatus).toUpperCase();

            if (existingPaymentStatus === _safeTrim(PAYMENT_STATUS_PENDING).toUpperCase()) {
                log.info("Idempotent duplicate: PENDING_PAYMENT, returning existing checkout", {
                    pairToken: pairToken,
                    traceId: traceId,
                });
                return {
                    status: "SUCCESS",
                    data: {
                        requiresPayment: true,
                        checkoutUrl: existingCita.meta?.checkoutUrl || null,
                        pairToken: pairToken,
                        bookingId: existingCita.bookingId || null,
                        idempotent: true,
                    },
                    error: null,
                };
            }

            log.info("Idempotent duplicate: existing cita found", {
                pairToken: pairToken,
                traceId: traceId,
                status: existingCita.bookingStatus || existingCita.status,
            });
            return {
                status: "SUCCESS",
                data: {
                    bookingId: existingCita.bookingId,
                    pairToken: pairToken,
                    status: existingCita.bookingStatus || existingCita.status,
                    idempotent: true,
                },
                error: null,
            };
        }

        // =========================================================================
        // PHASE 4: INIT TRANSACTION
        // =========================================================================
        const payloadHash = _hashKey(
            _stableSerialize({
                serviceId: serviceId,
                resourceId: finalResourceId || requestedResourceId,
                f1LocalStart: f1LocalStart,
                f1LocalEnd: f1LocalEnd,
                f2LocalStart: f2LocalStart,
                f2LocalEnd: f2LocalEnd,
                email: email,
                addOnIds: detectedAddonIds,
            })
        );

        const txResult = await _initTransaction(pairToken, payloadHash, traceId);
        if (!txResult.success) {
            if (txResult.error === "PAIR_TOKEN_PAYLOAD_MISMATCH") {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Payload mismatch for existing pairToken", { traceId: traceId }
                );
            }
            if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
                throw createBookingError(
                    ERROR_CODES.BOOKING_CREATION_FAILED,
                    "Previous transaction failed", { traceId: traceId }
                );
            }
            if (txResult.existing?.status === "COMPLETED") {
                return {
                    status: "SUCCESS",
                    data: txResult.existing.result,
                    error: null,
                    idempotent: true,
                };
            }
            throw createBookingError(
                ERROR_CODES.TOKEN_BUSY,
                "Transaction in progress or timeout", { traceId: traceId }
            );
        }

        // =========================================================================
        // PHASE 5: ACQUIRE LOCKS + HEARTBEAT
        // =========================================================================
        const phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
            localStart: f1LocalStart,
            localEnd: f1LocalEnd,
        }, ];
        if (isDual && f2LocalStart) {
            phases.push({
                rawSlot: Object.assign({}, validatedSlotF2, { serviceId: linkedPhases }),
                localStart: f2LocalStart,
                localEnd: f2LocalEnd,
            });
        }

        const lockKeys = _buildLockKeys(phases, finalResourceId);
        const lockOwnerId = pairToken;
        let heartbeatInterval = null;

        const saga = new BookingSagaOrchestrator(traceId);
        const createdBookings = [];

        saga.addStep(
            "LockSlots",
            async function () {
                    for (const lockKey of lockKeys) {
                        const lockResult = await _lockSlotKeyOrFail(
                            lockKey,
                            lockOwnerId,
                            LOCKTTLMS
                        );
                        if (!lockResult?.ok) {
                            throw createBookingError(
                                ERROR_CODES.TOKEN_BUSY,
                                "Lock failed: " + (lockResult?.message || "unknown"), { traceId: traceId, lockKey: lockKey }
                            );
                        }
                    }
                    heartbeatInterval = setInterval(function () {
                        lockKeys.forEach(function (key) {
                            _renewLock(key, lockOwnerId, LOCKTTLMS).catch(function (err) {
                                log.warn("heartbeat: lock renewal failed", {
                                    key: key,
                                    traceId: traceId,
                                    error: err?.message,
                                });
                            });
                        });
                    }, HEARTBEATMS);
                    return { lockKeys: lockKeys };
                },
                async function () {
                    if (heartbeatInterval) {
                        clearInterval(heartbeatInterval);
                        heartbeatInterval = null;
                    }
                    await _bestEffortUnlockAll(lockKeys, lockOwnerId);
                }
        );

        // =========================================================================
        // CREACION SECUENCIAL F1 -> F2
        // SAGA-01: skipAvailabilityValidation = false
        // SAGA-03: location OWNER_BUSINESS + guard de contrato
        // SAGA-04: addOnIds inyectados
        // =========================================================================
        saga.addStep(
            "CreateBookings",
            async function () {
                    const contactDetails = {
                        firstName: _safeTrim(
                            unsafePayload?.firstName || metaCita.firstName || ""
                        ),
                        lastName: _safeTrim(
                            unsafePayload?.lastName || metaCita.lastName || ""
                        ),
                        email: email,
                        phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
                    };

                    // SAGA-01: opciones unicas para ambas fases.
                    const bookingOptions = Object.freeze({
                        flowControlSettings: Object.freeze({
                            skipAvailabilityValidation: SKIP_AVAILABILITY_VALIDATION,
                        }),
                    });

                    let bookingF1 = null;
                    let bookingF2 = null;
                    let pristineF2 = null;
                    let f2Meta = null;

                    // ---------------- F1 ----------------
                    const pristineF1 = await _forceStaffInPristineSlot(
                        Object.assign({},
                            validatedSlotF1, { location: bookingLocation },
                            addonSlotFields
                        ),
                        finalResourceId,
                        serviceId,
                        serviceConfig.phase1Duration
                    );

                    if (!pristineF1) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Failed to build pristine slot F1", { traceId: traceId }
                        );
                    }

                    // SAGA-03: el pristine slot puede haber perdido la ubicacion
                    // si _forceStaffInPristineSlot reconstruye el objeto. Se
                    // re-aplica y se valida el contrato BIBLIA 2.2.1.
                    pristineF1.location = bookingLocation;
                    _assertPristineSlotContract(pristineF1, "F1", traceId);

                    const bookingBodyF1 = {
                        bookedEntity: { slot: pristineF1 },
                        contactDetails: contactDetails,
                        totalParticipants: 1,
                    };
                    const payMethodEarly = _safeTrim(
                        unsafePayload?.paymentMethod ||
                        PAYMENT_METHOD?.ONLINE ||
                        "ONLINE"
                    ).toUpperCase();
                    if (
                        payMethodEarly ===
                        _safeTrim(PAYMENT_METHOD?.ONLINE).toUpperCase() ||
                        payMethodEarly === "ONLINE"
                    ) {
                        bookingBodyF1.selectedPaymentOption = "ONLINE";
                    }
                    const resF1 = await _createBookingWithSelectiveElevation(
                        bookingBodyF1,
                        bookingOptions,
                        traceId
                    );

                    bookingF1 = resF1?.booking || resF1;
                    const f1Meta = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                    _checkDoubleBookingFlag(bookingF1, "F1", traceId);

                    createdBookings.push({
                        bookingId: f1Meta.bookingId,
                        revision: f1Meta.revision,
                        status: f1Meta.status,
                        phase: "F1",
                    });

                    // ---------------- F2 (solo dual) ----------------
                    if (isDual && f2LocalStart && validatedSlotF2) {
                        pristineF2 = await _forceStaffInPristineSlot(
                            Object.assign({},
                                validatedSlotF2, { location: bookingLocation },
                                addonSlotFields
                            ),
                            finalResourceId,
                            linkedPhases,
                            serviceConfig.phase2Duration
                        );

                        if (!pristineF2) {
                            throw createBookingError(
                                ERROR_CODES.INVALID_PAYLOAD,
                                "Failed to build pristine slot F2", { traceId: traceId }
                            );
                        }

                        pristineF2.location = bookingLocation;
                        _assertPristineSlotContract(pristineF2, "F2", traceId);

                        const bookingBodyF2 = {
                            bookedEntity: { slot: pristineF2 },
                            contactDetails: contactDetails,
                            totalParticipants: 1,
                        };
                        if (
                            payMethodEarly ===
                            _safeTrim(PAYMENT_METHOD?.ONLINE).toUpperCase() ||
                            payMethodEarly === "ONLINE"
                        ) {
                            bookingBodyF2.selectedPaymentOption = "ONLINE";
                        }
                        const resF2 = await _createBookingWithSelectiveElevation(
                            bookingBodyF2,
                            bookingOptions,
                            traceId
                        );

                        bookingF2 = resF2?.booking || resF2;
                        f2Meta = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                        _checkDoubleBookingFlag(bookingF2, "F2", traceId);

                        createdBookings.push({
                            bookingId: f2Meta.bookingId,
                            revision: f2Meta.revision,
                            status: f2Meta.status,
                            phase: "F2",
                        });
                    }

                    return {
                        bookingF1: bookingF1,
                        bookingF2: bookingF2,
                        createdBookings: createdBookings,
                        scheduleIdF1: _safeTrim(pristineF1?.scheduleId) || null,
                        scheduleIdF2: _safeTrim(pristineF2?.scheduleId) || null,
                        revisionF1: f1Meta.revision,
                        revisionF2: f2Meta?.revision || null,
                    };
                },
                async function () {
                    await _compensateCreatedBookings(createdBookings, traceId);
                }
        );

        // =========================================================================
        // CHECKOUT ONLINE / CONFIRMACION PRESENCIAL
        // SAGA-05: PAYMENT_STATUS.NOT_PAID (sin literales)
        // =========================================================================
        const paymentMethod = _safeTrim(
            unsafePayload?.paymentMethod || metaCita.paymentMethod || "PRESENCIAL"
        ).toUpperCase();

        const isOnline =
            paymentMethod === _safeTrim(PAYMENT_METHOD?.ONLINE).toUpperCase();

        saga.addStep(
            isOnline ? "CreateCheckout" : "ConfirmPresencial",
            async function () {
                    if (isOnline) {
                        const bookingIds = createdBookings
                            .map(function (b) { return b.bookingId; })
                            .filter(Boolean);

                        const checkoutPayload = {
                            lineItems: bookingIds.map(function (bookingId) {
                                return {
                                    catalogReference: {
                                        appId: APP_IDS.BOOKINGS,
                                        catalogItemId: bookingId,
                                        options: {},
                                    },
                                    quantity: 1,
                                };
                            }),
                            channelType: "WEB",
                        };

                        const checkoutRes = await withTimeout(
                            () => createCheckoutElevated(checkoutPayload),
                            CHECKOUT_TIMEOUT_MS,
                            "createCheckout"
                        );

                        const checkoutUrl = await _executeWithRetry(
                            () =>
                            withTimeout(
                                () =>
                                getCheckoutUrlElevated(
                                    _extractCheckoutId(checkoutRes)
                                ),
                                API_TIMEOUT_MS,
                                "getCheckoutUrl"
                            ),
                            2,
                            300
                        );

                        return {
                            requiresPayment: true,
                            checkoutUrl: checkoutUrl,
                            bookingIds: bookingIds,
                        };
                    }

                    for (const booking of createdBookings) {
                        const confirmResult = await _executeWithRetry(
                            () =>
                            withTimeout(
                                () =>
                                confirmOrDeclineBookingElevated(booking.bookingId, {
                                    // SAGA-05: constante SSOT, nunca literal.
                                    paymentStatus: PAYMENT_STATUS_NOT_PAID,
                                }),
                                API_TIMEOUT_MS,
                                "confirmOrDecline"
                            ),
                            2,
                            300
                        );
                        _checkDoubleBookingFlag(
                            confirmResult,
                            "CONFIRM_" + booking.phase,
                            traceId
                        );

                        // SAGA-06: tras confirmar, el booking pasa a CONFIRMED y ya
                        // no es cancelable. Se actualiza el estado local para que la
                        // compensacion posterior lo respete.
                        // FASE2 (ADR-06): se escribe en bookingStatus (canonico);
                        // el setter legado "status" queda eliminado del objeto local.
                        booking.bookingStatus =
                            _safeTrim(confirmResult?.booking?.bookingStatus) ||
                            _safeTrim(confirmResult?.booking?.status) ||
                            _safeTrim(confirmResult?.bookingStatus) ||
                            _safeTrim(confirmResult?.status) ||
                            BOOKING_STATUS_CONFIRMED;
                    }

                    return {
                        requiresPayment: false,
                        bookingIds: createdBookings.map(function (b) {
                            return b.bookingId;
                        }),
                    };
                },
                async function () {}
        );

        const paymentStatus = isOnline ?
            PAYMENT_STATUS_PENDING :
            PAYMENT_STATUS_NOT_PAID;

        const citaStatus = isOnline ?
            BOOKING_STATUS_PENDING_PAYMENT :
            BOOKING_STATUS_CONFIRMED;

        // =========================================================================
        // PERSISTENCIA EN CitasF2 (BIBLIA 4.6)
        // =========================================================================
        saga.addStep(
            "PersistCitas",
            async function () {
                    const checkoutStepName = isOnline ?
                        "CreateCheckout" :
                        "ConfirmPresencial";

                    const checkoutStepResult =
                        saga.completedSteps.find(function (s) {
                            return s.name === checkoutStepName;
                        })?.result || null;

                    const resolvedCheckoutUrl = checkoutStepResult?.checkoutUrl || null;

                    const createBookingsResult =
                        saga.completedSteps.find(function (s) {
                            return s.name === "CreateBookings";
                        })?.result || {};

                    const bookingF1Id = createdBookings.find(function (b) {
                        return b.phase === "F1";
                    })?.bookingId;

                    const bookingF2Id = createdBookings.find(function (b) {
                        return b.phase === "F2";
                    })?.bookingId;

                    const revisionF1 = Number(createBookingsResult.revisionF1) || 1;
                    const revisionF2 = Number(createBookingsResult.revisionF2) || 1;

                    let scheduleIdF1 = _isGuidOrNull(createBookingsResult.scheduleIdF1);
                    if (!scheduleIdF1) {
                        scheduleIdF1 = await _resolveScheduleIdForResource(
                            finalResourceId,
                            validatedSlotF1
                        );
                    }
                    if (!scheduleIdF1) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Unable to resolve scheduleId for F1", { traceId, bookingId: bookingF1Id }
                        );
                    }

                    await _persistBooking({
                            bookingId: bookingF1Id,
                            revision: revisionF1,
                            serviceId: serviceId,
                            scheduleId: scheduleIdF1,
                            resourceId: finalResourceId,
                            staffResourceId: finalResourceId,
                            startDate: getUtcDateFromMadridLocal(f1LocalStart),
                            endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                            dateYmd: f1LocalStart.slice(0, 10),
                            bookingType: isDual ? BOOKING_TYPE.DUALF1 : BOOKING_TYPE.SIMPLE,
                            status: citaStatus,
                            bookingStatus: citaStatus,
                            paymentStatus: paymentStatus,
                            pairToken: pairToken,
                            contactDetails: { email: email },
                            locationId: bookingLocation.id,
                            meta: {
                                pairToken: pairToken,
                                pairTokenSource: tokenResolution.source,
                                f1Start: f1LocalStart,
                                f1End: f1LocalEnd,
                                f2Start: f2LocalStart || null,
                                f2End: f2LocalEnd || null,
                                checkoutUrl: resolvedCheckoutUrl,
                                nativeAddonIds: detectedAddonIds,
                                addOnIds: detectedAddonIds,
                                locationType: "OWNER_BUSINESS",
                                writerRevision: revisionF1,
                            },
                            traceId: traceId,
                        },
                        traceId
                    );

                    if (isDual && bookingF2Id) {
                        let scheduleIdF2 = _isGuidOrNull(
                            createBookingsResult.scheduleIdF2
                        );
                        if (!scheduleIdF2) {
                            scheduleIdF2 = await _resolveScheduleIdForResource(
                                finalResourceId,
                                validatedSlotF2
                            );
                        }
                        if (!scheduleIdF2) {
                            throw createBookingError(
                                ERROR_CODES.INVALID_PAYLOAD,
                                "Unable to resolve scheduleId for F2", { traceId, bookingId: bookingF2Id }
                            );
                        }

                        await _persistBooking({
                                bookingId: bookingF2Id,
                                revision: revisionF2,
                                serviceId: linkedPhases,
                                scheduleId: scheduleIdF2,
                                resourceId: finalResourceId,
                                staffResourceId: finalResourceId,
                                startDate: getUtcDateFromMadridLocal(f2LocalStart),
                                endDate: getUtcDateFromMadridLocal(f2LocalEnd),
                                dateYmd: f2LocalStart.slice(0, 10),
                                bookingType: BOOKING_TYPE.DUALF2,
                                status: citaStatus,
                                bookingStatus: citaStatus,
                                paymentStatus: paymentStatus,
                                pairToken: pairToken,
                                contactDetails: { email: email },
                                locationId: bookingLocation.id,
                                meta: {
                                    pairToken: pairToken,
                                    pairTokenSource: tokenResolution.source,
                                    linkedF1BookingId: bookingF1Id,
                                    nativeAddonIds: detectedAddonIds,
                                    addOnIds: detectedAddonIds,
                                    locationType: "OWNER_BUSINESS",
                                    writerRevision: revisionF2,
                                },
                                traceId: traceId,
                            },
                            traceId
                        );
                    }

                    return {
                        bookingF1Id: bookingF1Id,
                        bookingF2Id: bookingF2Id || null,
                        resolvedCheckoutUrl: resolvedCheckoutUrl,
                        citaStatus: citaStatus,
                        isOnline: isOnline,
                        revisionF1: revisionF1,
                        revisionF2: revisionF2,
                    };
                },
                async function () {
                    await _deleteCitasByPairToken(pairToken, traceId);
                }
        );

        // =========================================================================
        // PHASE 6: EXECUTE SAGA
        // =========================================================================
        const sagaStartTime = Date.now();

        try {
            await saga.execute();

            const persistStepResult =
                saga.completedSteps.find(function (s) {
                    return s.name === "PersistCitas";
                })?.result || null;

            const finalResult = {
                bookingIds: createdBookings.map(function (b) {
                    return b.bookingId;
                }),
                bookingId: createdBookings.find(function (b) {
                    return b.phase === "F1";
                })?.bookingId || null,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                resourceId: finalResourceId,
                location: bookingLocation,
                requiresPayment: isOnline,
                checkoutUrl: persistStepResult?.resolvedCheckoutUrl || null,
                status: persistStepResult?.citaStatus || citaStatus,
                paymentStatus: paymentStatus,
                addOnIds: detectedAddonIds,
            };

            try {
                await _completeTransaction(pairToken, finalResult, traceId);
            } catch (completeErr) {
                log.error("_completeTransaction failed; compensating full saga", {
                    pairToken,
                    traceId,
                    error: completeErr?.message,
                });
                try {
                    await _deleteCitasByPairToken(pairToken, traceId);
                } catch (_) { /* best effort */ }
                try {
                    await _compensateCreatedBookings(createdBookings, traceId);
                } catch (_) { /* best effort */ }
                throw completeErr;
            }

            const madridDateYMD = f1LocalStart.slice(0, 10);
            const serviceIdForInvalidate = serviceId;
            const resourceIdForInvalidate = finalResourceId;

            setTimeout(function () {
                _invalidateCachesInternal(
                    serviceIdForInvalidate,
                    madridDateYMD,
                    resourceIdForInvalidate,
                    traceId
                ).catch(function (e) {
                    log.warn("Post-commit cache invalidation failed (background)", {
                        traceId,
                        error: e?.message,
                    });
                });
            }, 0);

            log.info("executeBookingSaga completed", {
                traceId: traceId,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                bookingIds: createdBookings.map(function (b) {
                    return b.bookingId;
                }),
                locationType: bookingLocation.locationType,
                addonCount: detectedAddonIds.length,
                requiresPayment: isOnline,
                skipAvailabilityValidation: SKIP_AVAILABILITY_VALIDATION,
                elapsedMs: Date.now() - sagaStartTime,
            });

            return { status: "SUCCESS", data: finalResult, error: null };
        } catch (sagaErr) {
            try {
                await _failTransaction(
                    pairToken,
                    normalizeError(sagaErr)?.code || "SAGA_FAILED"
                );
            } catch (failErr) {
                log.warn("_failTransaction could not be recorded", {
                    pairToken,
                    traceId,
                    error: failErr?.message,
                });
            }
            throw sagaErr;
        } finally {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            await _bestEffortUnlockAll(lockKeys, lockOwnerId).catch(function () {});
        }
    } catch (error) {
        const norm = normalizeError(error);
        log.error("executeBookingSaga failed", {
            code: norm.code,
            error: norm.message,
            traceId: traceId,
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
                message: norm.message,
            },
        };
    }
}
