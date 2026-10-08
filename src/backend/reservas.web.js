/**
 * ============================================================================
 * FILE: backend/reservas.web.js
 * VERSION: v5009-FISCAL-V20.1
 * BASE: v5008.13-STAFF-LOAD-BALANCE + Directriz V20 (IDs nativa en ingles)
 * RESPONSIBILITY: Availability engine, dual slots, staff pairing and caching.
 * STANDARDS: G10 ASCII Strict.
 *
 * FIXES APLICADOS v5009-FISCAL-V20.1:
 *  - V20-01: import ESTADO_CITA -> BOOKING_STATUS (internalConfig V20.1).
 *  - V20-02: uso de BOOKING_STATUS.CANCELLED en _countStaffLoadForDay.
 *  - V20-03: resto del modulo sin cambios funcionales (campos CMS
 *            ya estaban en ingles).
 *
 * FIXES APLICADOS v5008.13 (heredados):
 *  - FIX-DOC-BALANCE-A: export movido a _getCertifiedDualSlotsInternal.
 *  - FIX-DOC-BALANCE-B: pickStaffByLowestLoad desde bookingUtils v5008.3.
 *  - FIX-DOC-BALANCE-C: limite del conteo desde SDK_CONFIG.JOBS.
 *  - FIX-21..24, FIX-30, FIX-R1, FIX-R2.
 * ============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import wixData from "backend/dataAccess";
import { availabilityTimeSlots } from "@wix/bookings";

import {
    BUSINESS_COLLECTIONS,

    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    STAFF_DEFAULT_NAME,
    BOOKING_STATUS,
    BOOKING_FIELDS
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    _executeWithRetry,
    withTimeout
} from "public/mmUtils";

import {
    cleanGuidList,
    readDurationRange,
    resolveExpectedSlotMinutes,
    resolveLinkedPhase2Duration,
    computeGapMinutes,
    toUtcRange,
    pickStaffByLowestLoad
} from "backend/booking/bookingUtils";

import { logger } from "backend/logger";
import { getStaffDisplayName } from "backend/staff";
import { normalizeBookingStatus } from "backend/validation";

const log = logger;

// ============================================================================
// HELPERS INTERNOS
// ============================================================================

function _readServiceField(service, field) {
    if (!service || typeof service !== "object") return null;
    return service[field] ?? null;
}

function _normalizeAddon(addOn) {
    if (!addOn || typeof addOn !== "object") return null;
    const addOnId = _safeTrim(addOn.addOnId);
    const name = _safeTrim(addOn.name);
    const price = Number(addOn.price);
    if (!addOnId || !name || !Number.isFinite(price)) return null;
    return {
        addOnId,
        name,
        price,
        nativeId: _safeTrim(addOn.nativeId) || null
    };
}

const SERVICIOS_COL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const WATCHDOG_TIMEOUT_MS = SDK_CONFIG.TIMEOUTS.WATCHDOG_MS;
const SERVICE_CACHE_TTL_MS = SDK_CONFIG.CACHE.SERVICES_TTL_MS;
const DIAS_LIMITE = SLOT_SEARCH.DIAS_LIMITE;
const MINUTOS_MAX_HUECO_DUAL = Math.max(
    0,
    Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL) || 120
);
const CACHE_MAX_SIZE = SDK_CONFIG.CACHE.MAX_ENTRIES;
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const STAFF_LOAD_QUERY_LIMIT = Math.max(
    100,
    Number(SDK_CONFIG?.JOBS?.HEALTH_CHECK_QUERY_LIMIT) || 1000
);

const CONFIGURED_LOCATION_TYPE = _safeTrim(
    SDK_CONFIG.LOCATION_TYPES?.TIME_SLOTS
);

const LOCATION_TS = Object.freeze({
    id: SDK_CONFIG.LOCATION_ID,
    locationType:
        !CONFIGURED_LOCATION_TYPE ||
        CONFIGURED_LOCATION_TYPE === "BUSINESS" ?
        "OWNER_BUSINESS" :
        CONFIGURED_LOCATION_TYPE
});

const serviceCatalogRAM = new Map();

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= maxSize) return;
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
}

function _toPublicError(err, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "Internal Error") {
    return {
        code: String(err?.code || fallbackCode),
        message: String(err?.message || fallbackMessage)
    };
}

function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return { ...slot.slot, ...slot };
    }
    return slot;
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const normalizedSlot = _normalizeSlotShape(slot);
    if (!normalizedSlot) return null;
    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", { traceId, ctx, serviceId });
        return null;
    }
    return {
        ...normalizedSlot,
        serviceId,
        ...(normalizedSlot.slot && typeof normalizedSlot.slot === "object" ?
            { slot: { ...normalizedSlot.slot, serviceId } } :
            {})
    };
}

function _isValidMadridYmd(value) {
    const ymd = _safeTrim(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function _normalizeResourceIds(resourceId, traceId) {
    if (!resourceId) return [];
    const normalized = _safeTrim(resourceId);
    if (!normalized || ["all", "any"].includes(normalized.toLowerCase())) return [];
    if (_looksLikeGuid(normalized)) return [normalized];
    log.warn("_normalizeResourceIds: invalid resource identifier", {
        resourceId: normalized,
        traceId
    });
    return [];
}

function _getResourceIdsFromSlot(slot) {
    const normalizedSlot = _normalizeSlotShape(slot);
    if (!normalizedSlot || typeof normalizedSlot !== "object") return [];

    let groups = [];
    if (Array.isArray(normalizedSlot.availableResources)) {
        groups = normalizedSlot.availableResources;
    } else if (
        normalizedSlot.slot &&
        typeof normalizedSlot.slot === "object" &&
        Array.isArray(normalizedSlot.slot.availableResources)
    ) {
        groups = normalizedSlot.slot.availableResources;
    }

    if (groups.length > 0) {
        const staffGroup = groups.find(
            (group) =>
            String(group?.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID)
        );
        if (!staffGroup) return [];
        return Array.from(
            new Set(
                (staffGroup.resources || [])
                .map((resource) =>
                    _safeTrim(resource?.id || resource?._id || resource?.resourceId)
                )
                .filter((resourceId) => _looksLikeGuid(resourceId))
            )
        );
    }

    const directId = _safeTrim(
        normalizedSlot.resource?.id ||
        normalizedSlot.resource?._id ||
        normalizedSlot.resource?.resourceId ||
        normalizedSlot.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    const milliseconds = b.getTime() - a.getTime();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
    return Math.round(milliseconds / 60000);
}

function _isValidSlotRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startLocal));
    const endUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endLocal));
    return Boolean(startUtc && endUtc && endUtc.getTime() > startUtc.getTime());
}

async function _getStaffDisplayNamePublic(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return STAFF_DEFAULT_NAME;
    try {
        const name = await getStaffDisplayName(id);
        return _safeTrim(name) || STAFF_DEFAULT_NAME;
    } catch (_) {
        return STAFF_DEFAULT_NAME;
    }
}

function _getRequestedAddonContext(service, requestedAddonIds) {
    const requested = new Set(
        (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
        .map((id) => _safeTrim(id))
        .filter(Boolean)
    );
    // MATRIZ A-E SSOT v7.0: add-ons are read only from the canonical
    // addOnOptions DTO projection (service.addOnOptions). No legacy
    // metadata.addons alias is consumed.
    const addOnOptions = Array.isArray(service?.addOnOptions) ?
        service.addOnOptions :
        [];
    const selected = addOnOptions.filter((addon) => {
        const id = _safeTrim(addon?.addOnId);
        const nativeId = _safeTrim(addon?.nativeId);
        return requested.has(id) || requested.has(nativeId);
    });
    return {
        nativeAddonIds: Array.from(
            new Set(
                selected
                .map((addon) => _safeTrim(addon?.nativeId || addon?.addOnId))
                .filter((id) => _looksLikeGuid(id))
            )
        ),
        addOnOptions: selected
    };
}

function _resolveAddonContextInternal(service, requestedAddonIds) {
    return _getRequestedAddonContext(service, requestedAddonIds);
}

async function _verifyRequiredStaffViaGet({
    serviceId,
    start,
    end,
    requiredResourceId,
    nativeAddonIds,
    traceId
}) {
    const getPayload = {
        serviceId: String(serviceId),
        localStartDate: start,
        localEndDate: end,
        location: LOCATION_TS,
        timeZone: SDK_CONFIG.TZ,
        resourceTypes: [
            { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }
        ]
    };
    if (Array.isArray(nativeAddonIds) && nativeAddonIds.length > 0) {
        getPayload.customerChoices = { addOnIds: nativeAddonIds };
    }
    try {
        const result = await _executeWithRetry(
            () =>
            withTimeout(
                () => availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
                WATCHDOG_TIMEOUT_MS,
                "exactSlot:verifyStaffGet"
            ),
            2,
            300
        );
        if (result?.timeSlot) return { ok: true, slot: result.timeSlot, errorCode: null };
        return { ok: false, slot: null, errorCode: "STAFF_UNAVAILABLE" };
    } catch (error) {
        log.warn("getAvailabilityTimeSlot verification failed", {
            traceId,
            serviceId: String(serviceId),
            requiredResourceId,
            message: error?.message
        });
        return { ok: false, slot: null, errorCode: "STAFF_UNAVAILABLE" };
    }
}

// ============================================================================
// SERVICE CATALOG
// ============================================================================

export async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
    const traceId = externalTraceId || makeTraceId("service");
    const raw = _safeTrim(slugOrId);
    const isGuid = _looksLikeGuid(raw);

    const clean = isGuid ?
        raw :
        _safeTrim(raw) ?
        String(raw).split("?")[0].split("#")[0].replace(/^\//, "").replace(/\/$/, "") :
        "";

    if (!clean) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service identifier is required." }
        };
    }

    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
        return { status: "SUCCESS", data: cached.data, error: null };
    }

    try {
        let result;

        if (isGuid) {
            result = await withTimeout(
                () => wixData.query(SERVICIOS_COL).eq("serviceId", clean).limit(1).find({ suppressAuth: true }),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:serviceId"
            );
        } else {
            result = await withTimeout(
                () => wixData.query(SERVICIOS_COL).eq("slug", clean).limit(1).find({ suppressAuth: true }),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:slug"
            );

            if (!result?.items?.[0] && _looksLikeGuid(clean)) {
                result = await withTimeout(
                    () => wixData.query(SERVICIOS_COL).eq("serviceId", clean).limit(1).find({ suppressAuth: true }),
                    WATCHDOG_TIMEOUT_MS,
                    "getServiceBySlugOrId:guidFallback"
                );
            }
        }

        const service = result?.items?.[0] || null;
        if (!service) {
            log.error("Service not found in catalog", { key: clean, traceId });
            return {
                status: "ERROR",
                data: null,
                error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
            };
        }

        const mapped = await _mapServiceImport2ToUX(service, traceId);
        const cacheEntry = { data: mapped, timestamp: Date.now() };
        _cacheSetBounded(serviceCatalogRAM, clean, cacheEntry, CACHE_MAX_SIZE);
        if (mapped.serviceId) {
            _cacheSetBounded(serviceCatalogRAM, mapped.serviceId, cacheEntry, CACHE_MAX_SIZE);
        }
        if (mapped.slug) {
            _cacheSetBounded(serviceCatalogRAM, mapped.slug, cacheEntry, CACHE_MAX_SIZE);
        }

        return { status: "SUCCESS", data: mapped, error: null };
    } catch (error) {
        log.error("Error loading service", { traceId, message: error?.message });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DATABASE_ERROR",
                message: error?.message || "Error loading service."
            }
        };
    }
}

export async function _resolveServiceIdInternal(serviceIdReq) {
    const raw = _safeTrim(serviceIdReq);
    if (!raw) return null;
    const key = _looksLikeGuid(raw) ? raw : _safeSlugOrId(raw);
    if (!key) return null;
    const result = await _getServiceBySlugOrIdInternal(key);
    if (result?.status === "SUCCESS" && result?.data?.serviceId) {
        const serviceId = _safeTrim(result.data.serviceId);
        if (_looksLikeGuid(serviceId)) return serviceId;
    }
    return null;
}

export async function _mapServiceImport2ToUX(service, traceId) {
    const serviceId = _safeTrim(_readServiceField(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("Catalog serviceId is missing or invalid.");
    }
    // MATRIZ D SSOT v7.0: canonical visibility key is clientHidden.
    const clientHidden = _readServiceField(service, "clientHidden") === true;
    const allowCombine = !clientHidden && _readServiceField(service, "allowCombine") === true;
    const linkedPhases = _safeTrim(_readServiceField(service, "linkedPhases"));

    if (allowCombine && !_looksLikeGuid(linkedPhases)) {
        throw new Error("Dual service linkedPhases is missing or invalid.");
    }
    if (allowCombine && _looksLikeGuid(linkedPhases) && linkedPhases === serviceId) {
        throw new Error("A service cannot link to itself (linkedPhases === serviceId).");
    }

    const phase1Duration = Number(_readServiceField(service, "phase1Duration")) || 0;
    const exposureDuration = Number(_readServiceField(service, "exposureDuration")) || 0;
    let phase2Duration = Number(_readServiceField(service, "phase2Duration")) || 0;

    if (allowCombine && _looksLikeGuid(linkedPhases)) {
        const visited = new Set([serviceId]);
        const resolved = await resolveLinkedPhase2Duration(
            linkedPhases,
            traceId,
            visited,
            _getServiceBySlugOrIdInternal
        );
        if (resolved > 0) phase2Duration = resolved;
    }

    // MATRIZ A-E SSOT v7.0: field "buffer" has no canonical equivalent and is
    // eliminated from the contract (no silent read).
    const title = _safeTrim(_readServiceField(service, "title")) || "Service";
    const price = Number(_readServiceField(service, "price")) || 0;
    const currency = _safeTrim(_readServiceField(service, "currency")) || "EUR";
    const pricingModel = _safeTrim(_readServiceField(service, "pricingModel")) || null;
    const slug = _safeTrim(_readServiceField(service, "slug")) || null;
    const serviceType = _safeTrim(_readServiceField(service, "serviceType")) || null;
    const sku = _safeTrim(_readServiceField(service, "sku")) || null;
    const depositAmount = Number(_readServiceField(service, "depositAmount")) || 0;
    const depositType = _safeTrim(_readServiceField(service, "depositType")) || null;
    const onlinePayment = _readServiceField(service, "onlinePayment") === true;
    const inPersonPayment = _readServiceField(service, "inPersonPayment") === true;
    const taxIncluded = _readServiceField(service, "taxIncluded") === true;
    // MATRIZ A-E SSOT v7.0: canonical AEAT fiscal key is tipoImpositivo.
    // Legacy alias taxRate is not read (no silent conversion).
    const tipoImpositivo = Number(_readServiceField(service, "tipoImpositivo")) || 0;
    const categoryId = _safeTrim(_readServiceField(service, "categoryId")) || null;
    const locationId = _safeTrim(_readServiceField(service, "locationId")) || null;
    const location = _safeTrim(_readServiceField(service, "location")) || null;
    const mainMedia = _safeTrim(_readServiceField(service, "mainMedia")) || "";
    const shortDescription = _safeTrim(_readServiceField(service, "tagLine")) || null;
    const longDescription = _safeTrim(_readServiceField(service, "description")) || null;
    const internalNotes = _safeTrim(_readServiceField(service, "internalNotes")) || null;

    const durationRange = readDurationRange(service);

    // MATRIZ E SSOT v7.0: totalDuration is ALWAYS the exact phase sum for
    // dual services (legacy stored value and fallback 30 eradicated).
    const phaseSum = allowCombine ?
        phase1Duration + exposureDuration + phase2Duration :
        phase1Duration;

    const estimatedTotal = phaseSum;

    const availableStaff = cleanGuidList(_readServiceField(service, "availableStaff"));

    const staffOptions = await Promise.all(
        availableStaff.map(async (resourceId) => {
            const displayName = await _getStaffDisplayNamePublic(resourceId);
            return {
                id: resourceId,
                value: resourceId,
                name: displayName,
                label: displayName
            };
        })
    );

    // MATRIZ A-E SSOT v7.0: canonical add-on collection is addOnOptions
    // with keys addOnId / price. No addons/addOns alias, no derived
    // addonsPrecio field.
    const addOnOptions = ((Array.isArray(_readServiceField(service, "addOnOptions")) ? _readServiceField(service, "addOnOptions") : []))
        .map(_normalizeAddon)
        .filter(Boolean);

    return {
        serviceId,
        slug,
        serviceType,
        sku,
        categoryId,
        locationId,
        localizacion: location,
        internalNotes,
        permitirCombinar: allowCombine,
        tiempoFase1: phase1Duration,
        tiempoExposicion: exposureDuration,
        tiempoFase2: phase2Duration,
        duracionTotal: estimatedTotal,
        availableStaff,
        staffOptions,
        depositAmount,
        depositType,
        onlinePayment,
        inPersonPayment,
        taxIncluded,
        tipoImpositivo,
        pricingModel,
        currency,
        linkedPhases: allowCombine ? linkedPhases : null,
        allowCombine,
        phase1Duration,
        exposureDuration,
        phase2Duration,
        totalDuration: estimatedTotal,
        clientHidden,
        durationRange,
        addOnOptions,
        mainMedia,
        metadata: {
            titulo: title,
            tituloServicio: title,
            precio: price,
            duracionTotal: estimatedTotal,
            localizacion: location,
            resumenCorto: shortDescription,
            descripcionLarga: longDescription,
            pricingModel,
            addOnOptions,
            mainMedia,
            currency,
            tipoImpositivo,
            pricing: { base: price, currency },
            timing: { estimatedTotal, totalDuration: estimatedTotal },
            durationRange
        }
    };
}

export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return _getServiceBySlugOrIdInternal(
        serviceId,
        traceId || makeTraceId("service-internal")
    );
}

// ============================================================================
// WEB METHODS - SERVICE
// ============================================================================

export const getServiceBySlugOrId = webMethod(
    Permissions.Anyone,
    async (slugOrId) => {
        const traceId = makeTraceId("wm-service");
        try {
            const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
            if (result?.status !== "SUCCESS") return result;
            return {
                status: "SUCCESS",
                data: _toPublicService(result.data),
                error: null
            };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "SERVICE_LOOKUP_FAILED")
            };
        }
    }
);

export const resolveServiceId = webMethod(
    Permissions.Anyone,
    async (serviceIdRequest) => {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdRequest);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
                };
            }
            return { status: "SUCCESS", data: String(resolved), error: null };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "SERVICE_RESOLVE_FAILED")
            };
        }
    }
);

export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    // MATRIZ A-E SSOT v7.0: internalNotes is stripped from the public DTO;
    // linkFases alias no longer exists in the mapped object.
    const { internalNotes, ...publicService } = service;
    return {
        ...publicService,
        linkedPhases: publicService.linkedPhases || null
    };
}

// ============================================================================
// CONFIRMATION PAGE READ (SSOT-07: page code never queries CMS directly)
// ============================================================================

// Public DTO whitelist for the confirmation page. NEVER add: margin,
// internalNotes, tipoImpositivo, codigoImpuesto, recordHash, previousRecordHash,
// payloadFiscal, nifEmisor, cuentaContable* (BIBLIA 15 / frontend minimo).
const _CONFIRMATION_DTO_FIELDS = Object.freeze([
    "bookingId",
    "serviceId",
    "dateYmd",
    "slotStart",
    "slotEnd",
    "resourceId",
    "pairToken",
    "totalPrice"
]);

function _toConfirmationDto(item) {
    if (!item || typeof item !== "object") return null;
    const dto = {};
    for (const key of _CONFIRMATION_DTO_FIELDS) {
        if (item[key] !== undefined && item[key] !== null) dto[key] = item[key];
    }
    // Canonical read with legacy transition fallback (EOL 31/12/2026, ADR-06):
    // rows persisted before FASE1 use the physical field "status"; the
    // projection ALWAYS exposes the canonical bookingStatus via the central
    // read normalizer (validation.js), never raw legacy fields.
    const rawStatus = item[BOOKING_FIELDS.STATUS];
    if (rawStatus === undefined || rawStatus === null) {
        if (item.status !== undefined && item.status !== null) dto.bookingStatus = normalizeBookingStatus(item.status);
    } else {
        dto.bookingStatus = normalizeBookingStatus(rawStatus);
    }
    if (item.paymentStatus !== undefined) dto.paymentStatus = item.paymentStatus;
    return dto;
}

/**
 * getConfirmedBookingForDisplay({ bookingId }) -> { ok, data }
 * Read-only projection of CitasF2 restricted to display-safe states.
 */
export const getConfirmedBookingForDisplay = webMethod(
    Permissions.Anyone,
    async ({ bookingId } = {}) => {
        const traceId = makeTraceId("confirmacion-booking");
        const cleanId = _safeTrim(bookingId);
        if (!cleanId) {
            return { ok: false, data: null, error: "BOOKING_ID_REQUIRED" };
        }
        try {
            const res = await withTimeout(
                wixData.query(BUSINESS_COLLECTIONS.CITAS_F2)
                .eq(BOOKING_FIELDS.BOOKING_ID, cleanId)
                .limit(1)
                .find({ suppressAuth: true }),
                Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000,
                "getConfirmedBookingForDisplay"
            );
            const item = res?.items?.[0] || null;
            if (!item) return { ok: false, data: null, error: "NOT_FOUND" };
            const status = normalizeBookingStatus(
                item[BOOKING_FIELDS.STATUS] ?? item.status
            );
            if (
                status !== BOOKING_STATUS.CONFIRMED &&
                status !== BOOKING_STATUS.PENDING
            ) {
                return { ok: false, data: null, error: "NOT_CONFIRMED" };
            }
            return { ok: true, data: _toConfirmationDto(item), error: null };
        } catch (err) {
            log.warn("getConfirmedBookingForDisplay failed", {
                traceId,
                error: err?.message
            });
            return { ok: false, data: null, error: "READ_FAILED" };
        }
    }
);

// ============================================================================
// DISPONIBILIDAD SINGLE
// ============================================================================

export const getAvailableSlots = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, dateYmd, addOnIds = []) => {
        const traceId = makeTraceId("available-slots");
        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(serviceIdOrSlug, traceId);
            if (serviceResult?.status !== "SUCCESS" || !serviceResult.data?.serviceId) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
                };
            }

            const service = serviceResult.data;
            const serviceId = service.serviceId;

            if (service.allowCombine === true) {
                log.warn("getAvailableSlots called for dual service", {
                    traceId,
                    serviceId: String(serviceId)
                });
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "SERVICE_IS_DUAL",
                        message: "Use getCertifiedDualSlots for dual services."
                    }
                };
            }

            const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _resolveAddonContextInternal(service, addOnIds);

            if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
                        message: "Services with a duration range cannot be combined with addons."
                    }
                };
            }

            const ymd = _safeTrim(dateYmd);
            if (!_isValidMadridYmd(ymd)) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "INVALID_DATE", message: "Invalid booking date." }
                };
            }

            const payload = {
                serviceId: String(serviceId),
                fromLocalDate: `${ymd}T00:00:00`,
                toLocalDate: `${ymd}T23:59:59`,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [LOCATION_TS],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID]
            };

            if (requestedResourceId.length > 0) {
                payload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: requestedResourceId }
                ];
            }

            if (addonContext.nativeAddonIds.length > 0) {
                payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
            }

            const result = await _executeWithRetry(
                () =>
                withTimeout(
                    () => availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                    WATCHDOG_TIMEOUT_MS,
                    "getAvailableSlots"
                ),
                2,
                300
            );

            const timeSlots = Array.isArray(result?.timeSlots) ? result.timeSlots : [];
            const slots = timeSlots
                .filter((slot) => slot?.bookable === true)
                .map((slot) => _attachServiceId(slot, serviceId, traceId, "getAvailableSlots"))
                .filter(Boolean);

            return {
                status: "SUCCESS",
                data: {
                    slots,
                    serviceId,
                    dateYmd: ymd,
                    resourceId: requestedResourceId[0] || null
                },
                error: null
            };
        } catch (error) {
            log.warn("getAvailableSlots failed", {
                traceId,
                serviceIdOrSlug: _safeTrim(serviceIdOrSlug),
                dateYmd: _safeTrim(dateYmd),
                message: error?.message
            });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "AVAILABLE_SLOTS_FAILED",
                    message: "Could not load available slots."
                }
            };
        }
    }
);

// ============================================================================
// DISPONIBILIDAD DIAS
// ============================================================================

export const getAvailableDays = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, year, month, addOnIds = []) => {
        const traceId = makeTraceId("available-days");
        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(serviceIdOrSlug, traceId);
            if (serviceResult?.status !== "SUCCESS" || !serviceResult.data?.serviceId) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
                };
            }

            const service = serviceResult.data;
            const serviceId = service.serviceId;
            const y = Number(year);
            const m = Number(month);

            if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "INVALID_DATE", message: "Invalid year/month." }
                };
            }

            const monthStr = String(m).padStart(2, "0");
            const fromDate = `${y}-${monthStr}-01T00:00:00`;
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const toDate = `${y}-${monthStr}-${String(lastDay).padStart(2, "0")}T23:59:59`;

            const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _resolveAddonContextInternal(service, addOnIds);

            const payload = {
                serviceId: String(serviceId),
                fromLocalDate: fromDate,
                toLocalDate: toDate,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [LOCATION_TS],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID]
            };

            if (requestedResourceId.length > 0) {
                payload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: requestedResourceId }
                ];
            }

            if (addonContext.nativeAddonIds.length > 0 && !service.durationRange) {
                payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
            }

            const result = await _executeWithRetry(
                () =>
                withTimeout(
                    () => availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                    WATCHDOG_TIMEOUT_MS,
                    "getAvailableDays"
                ),
                2,
                300
            );

            const timeSlots = Array.isArray(result?.timeSlots) ? result.timeSlots : [];
            const daySet = new Set();

            for (const slot of timeSlots) {
                if (slot?.bookable !== true) continue;
                const localStart = _normalizeLocalIsoStr(
                    slot?.localStartDate || slot?.startDate
                );
                if (!localStart) continue;
                daySet.add(localStart.slice(0, 10));
            }

            return {
                status: "SUCCESS",
                data: {
                    days: Array.from(daySet).sort(),
                    serviceId,
                    year: y,
                    month: m,
                    resourceId: requestedResourceId[0] || null
                },
                error: null
            };
        } catch (error) {
            log.warn("getAvailableDays failed", { traceId, message: error?.message });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "AVAILABLE_DAYS_FAILED",
                    message: "Could not load available days."
                }
            };
        }
    }
);

// ============================================================================
// STAFF LOAD COUNTS FOR DAY (CITAS_F2)
// ============================================================================

async function _countStaffLoadForDay(dateYmd, resourceIds, traceId) {
    const ymd = _safeTrim(dateYmd);
    const ids = cleanGuidList(resourceIds);
    const loadByResource = {};

    for (const id of ids) {
        loadByResource[id] = 0;
    }

    if (!ymd || ids.length === 0) {
        return loadByResource;
    }

    const cancelled = String(BOOKING_STATUS.CANCELED);
    const idSet = new Set(ids);

    try {
        const result = await withTimeout(
            () =>
            wixData
            .query(BUSINESS_COLLECTIONS.CITAS_F2)
            .eq("dateYmd", ymd)
            .limit(STAFF_LOAD_QUERY_LIMIT)
            .find({ suppressAuth: true }),
            WATCHDOG_TIMEOUT_MS,
            "staffLoad:countDay"
        );

        for (const item of result?.items || []) {
            // FASE2 ADR-06: lectura canonica primero; fallback legacy solo lectura.
            const rawStatus = item?.bookingStatus;
            if (rawStatus === undefined || rawStatus === null) {
                log.warn("CitasF2 fila sin bookingStatus (usa legacy status), migrar antes de EOL 31/12/2026", { id: item?._id });
            }
            const status = String(rawStatus || "").trim().toUpperCase();
            if (status === cancelled || status === "CANCELED" || status === "CANCELLED") {
                continue;
            }

            const resourceId = _safeTrim(item?.resourceId);
            if (!resourceId || !idSet.has(resourceId)) {
                continue;
            }

            loadByResource[resourceId] = (loadByResource[resourceId] || 0) + 1;
        }
    } catch (error) {
        log.warn("_countStaffLoadForDay failed; using zero loads", {
            traceId,
            dateYmd: ymd,
            message: error?.message
        });
    }

    return loadByResource;
}

// ============================================================================
// DISPONIBILIDAD DUAL
// ============================================================================

export async function _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYmd, addOnIds = []) {
    const traceId = makeTraceId("dual-slots");
    const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);

    if (serviceRes?.status !== "SUCCESS" || !serviceRes?.data) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
        };
    }

    const service = serviceRes.data;

    if (service.allowCombine !== true || !_looksLikeGuid(service.linkedPhases)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_DUAL", message: "Service is not configured as dual." }
        };
    }

    const ymd = _safeTrim(dateYmd);
    if (!_isValidMadridYmd(ymd)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALID_DATE", message: "Invalid booking date." }
        };
    }

    const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
    const addonContext = _resolveAddonContextInternal(service, addOnIds);

    if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
                message: "Services with a duration range cannot be combined with addons."
            }
        };
    }

    const buildListPayload = (svcId) => {
        const payload = {
            serviceId: String(svcId),
            fromLocalDate: `${ymd}T00:00:00`,
            toLocalDate: `${ymd}T23:59:59`,
            timeZone: SDK_CONFIG.TZ,
            bookable: true,
            locations: [LOCATION_TS],
            includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID]
        };
        if (requestedResourceId.length > 0) {
            payload.resourceTypes = [
                { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: requestedResourceId }
            ];
        }
        if (addonContext.nativeAddonIds.length > 0) {
            payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
        }
        return payload;
    };

    const f1Res = await _executeWithRetry(
        () =>
        withTimeout(
            () => availabilityTimeSlots.listAvailabilityTimeSlots(buildListPayload(service.serviceId)),
            WATCHDOG_TIMEOUT_MS,
            "dual:listF1"
        ),
        2,
        300
    );

    const f1Slots = (Array.isArray(f1Res?.timeSlots) ? f1Res.timeSlots : []).filter(
        (s) => s?.bookable === true
    );

    const f2Res = await _executeWithRetry(
        () =>
        withTimeout(
            () => availabilityTimeSlots.listAvailabilityTimeSlots(buildListPayload(service.linkedPhases)),
            WATCHDOG_TIMEOUT_MS,
            "dual:listF2"
        ),
        2,
        300
    );

    const f2Slots = (Array.isArray(f2Res?.timeSlots) ? f2Res.timeSlots : []).filter(
        (s) => s?.bookable === true
    );

    const staffPool = cleanGuidList(
        service.availableStaff || []
    );
    const loadByResource = await _countStaffLoadForDay(ymd, staffPool, traceId);

    const pairs = [];

    for (const f1 of f1Slots) {
        const f1Start = _normalizeLocalIsoStr(f1?.localStartDate || f1?.startDate);
        const f1End = _normalizeLocalIsoStr(f1?.localEndDate || f1?.endDate);
        if (!f1Start || !f1End) continue;

        const range = toUtcRange(f1Start, f1End);
        if (!range) continue;

        const f1Resources = _getResourceIdsFromSlot(f1);

        for (const f2 of f2Slots) {
            const f2Start = _normalizeLocalIsoStr(f2?.localStartDate || f2?.startDate);
            const f2End = _normalizeLocalIsoStr(f2?.localEndDate || f2?.endDate);
            if (!f2Start || !f2End) continue;

            const f2StartUtc = getUtcDateFromMadridLocal(f2Start);
            if (!f2StartUtc) continue;

            const gapMinutes = computeGapMinutes(range.endUtc, f2StartUtc);
            if (gapMinutes < 0 || gapMinutes > MINUTOS_MAX_HUECO_DUAL) continue;

            const f2Resources = _getResourceIdsFromSlot(f2);
            const shared = f1Resources.filter((id) => f2Resources.includes(id));
            if (shared.length === 0) continue;

            const pairResourceId =
                requestedResourceId[0] && shared.includes(requestedResourceId[0]) ?
                requestedResourceId[0] :
                pickStaffByLowestLoad(shared, loadByResource) || shared[0];

            pairs.push({
                fase1: {
                    slotRef: { ..._normalizeSlotShape(f1), serviceId: service.serviceId },
                    resourceId: pairResourceId
                },
                fase2: {
                    slotRef: { ..._normalizeSlotShape(f2), serviceId: service.linkedPhases },
                    resourceId: pairResourceId
                },
                pairToken: null,
                serviceId: service.serviceId,
                linkedPhases: service.linkedPhases,
                dateYmd: ymd,
                gapMinutes,
                exposureDuration: Number(service.exposureDuration || 0) || 0
            });
        }
    }

    return { status: "SUCCESS", data: pairs, error: null, traceId };
}

export const getCertifiedDualSlots = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, dateYmd, addOnIds = []) => {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
                };
            }
            return await _getCertifiedDualSlotsInternal(resolved, resourceId, dateYmd, addOnIds);
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "DUAL_SLOTS_FAILED")
            };
        }
    }
);

// ============================================================================
// RESOLUCION DE STAFF
// ============================================================================

export async function _resolveStaffForSlotInternal({
    serviceId,
    f1Start,
    f1End,
    f2Start,
    f2End,
    requestedResourceId,
    addOnIds = [],
    traceId
}) {
    const activeTraceId = traceId || makeTraceId("staff-resolve");
    const resolved = await _resolveServiceIdInternal(serviceId);

    if (!resolved) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
        };
    }

    const normalizedAddonIds = Array.from(
        new Set(
            (Array.isArray(addOnIds) ? addOnIds : [])
            .map((id) => _safeTrim(id))
            .filter((id) => _looksLikeGuid(id))
        )
    ).sort();

    const f1Result = await revalidateExactAvailabilitySlot({
        serviceId: resolved,
        localStartDate: f1Start,
        localEndDate: f1End,
        resourceId: requestedResourceId || null,
        nativeAddonIds: normalizedAddonIds,
        traceId: activeTraceId
    });

    if (f1Result?.status !== "SUCCESS") return f1Result;

    const finalResourceId = f1Result.data?.resourceId || requestedResourceId || null;

    let f2Result = null;

    if (f2Start && f2End) {
        const serviceConfig = await _getServiceBySlugOrIdInternal(resolved, activeTraceId);
        const linkedPhases = _safeTrim(
            serviceConfig?.data?.linkedPhases
        );

        if (!_looksLikeGuid(linkedPhases)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "INVALID_PAYLOAD",
                    message: "Dual requested but service has no linkedPhases."
                }
            };
        }

        f2Result = await revalidateExactAvailabilitySlot({
            serviceId: linkedPhases,
            localStartDate: f2Start,
            localEndDate: f2End,
            resourceId: finalResourceId,
            nativeAddonIds: normalizedAddonIds,
            traceId: activeTraceId
        });

        if (f2Result?.status !== "SUCCESS") return f2Result;
    }

    return {
        status: "SUCCESS",
        data: {
            resourceId: finalResourceId,
            slotF1: f1Result.data?.slot || null,
            slotF2: f2Result?.data?.slot || null
        },
        error: null
    };
}

export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, start, resourceId, addOnIds = [], end = null) => {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
                };
            }

            return await _resolveStaffForSlotInternal({
                serviceId: resolved,
                f1Start: start,
                f1End: end,
                f2Start: null,
                f2End: null,
                requestedResourceId: resourceId,
                addOnIds,
                traceId: makeTraceId("staff-resolve-wm")
            });
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "STAFF_RESOLVE_FAILED")
            };
        }
    }
);

// ============================================================================
// INVALIDACION DE CACHES
// ============================================================================

export async function _invalidateCachesInternal(serviceId, dateYmd, resourceId, traceId) {
    try {
        const sid = _safeTrim(serviceId);
        if (sid && _looksLikeGuid(sid) && serviceCatalogRAM.has(sid)) {
            serviceCatalogRAM.delete(sid);
        }

        log.info("_invalidateCachesInternal", {
            traceId,
            serviceId: sid || null,
            dateYmd: _safeTrim(dateYmd) || null,
            resourceId: _safeTrim(resourceId) || null
        });

        return { status: "SUCCESS" };
    } catch (error) {
        log.warn("_invalidateCachesInternal failed", {
            traceId,
            message: error?.message
        });
        return { status: "ERROR", error: error?.message || "UNKNOWN" };
    }
}

// ============================================================================
// REVALIDACION EXACTA
// ============================================================================

export async function revalidateExactAvailabilitySlot({
    serviceId,
    localStartDate,
    localEndDate,
    resourceId,
    nativeAddonIds = [],
    traceId
}) {
    const activeTraceId = traceId || makeTraceId("exact-slot");
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    const start = _normalizeLocalIsoStr(localStartDate);
    const end = _normalizeLocalIsoStr(localEndDate);

    const rawResourceId = _safeTrim(resourceId);
    const requiredResourceId = _looksLikeGuid(rawResourceId) ? rawResourceId : "";

    if (!resolvedServiceId || !start || !end || !_isValidSlotRange(start, end)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALID_SLOT_RECHECK", message: "Selected slot data is invalid." }
        };
    }

    try {
        const normalizedAddonIds = Array.from(
            new Set(
                (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
            )
        ).sort();

        const earlyServiceConfig = await _getServiceBySlugOrIdInternal(
            resolvedServiceId,
            activeTraceId
        );

        const serviceDurationRange =
            earlyServiceConfig?.status === "SUCCESS" && earlyServiceConfig?.data?.durationRange ?
            earlyServiceConfig.data.durationRange :
            null;

        if (normalizedAddonIds.length > 0 && serviceDurationRange) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
                    message: "Services with a duration range cannot be combined with addons.",
                    traceId: activeTraceId
                }
            };
        }

        let rawSlot = null;

        if (normalizedAddonIds.length > 0) {
            const listPayload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: start,
                toLocalDate: end,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [LOCATION_TS],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
                customerChoices: { addOnIds: normalizedAddonIds }
            };

            if (requiredResourceId) {
                listPayload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }
                ];
            }

            const listed = await _executeWithRetry(
                () =>
                withTimeout(
                    () => availabilityTimeSlots.listAvailabilityTimeSlots(listPayload),
                    WATCHDOG_TIMEOUT_MS,
                    "exactSlot:list"
                ),
                2,
                300
            );

            rawSlot =
                (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find((slot) => {
                    const slotStart = _normalizeLocalIsoStr(
                        slot?.localStartDate || slot?.startDate
                    );
                    const slotEnd = _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate);
                    return slotStart === start && slotEnd === end && slot?.bookable === true;
                }) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: LOCATION_TS,
                timeZone: SDK_CONFIG.TZ
            };

            if (requiredResourceId) {
                getPayload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }
                ];
            }

            const result = await _executeWithRetry(
                () =>
                withTimeout(
                    () => availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
                    WATCHDOG_TIMEOUT_MS,
                    "exactSlot:get"
                ),
                2,
                300
            );

            rawSlot = result?.timeSlot || null;
        }

        if (requiredResourceId) {
            const verification = await _verifyRequiredStaffViaGet({
                serviceId: resolvedServiceId,
                start,
                end,
                requiredResourceId,
                nativeAddonIds: normalizedAddonIds,
                traceId: activeTraceId
            });

            if (!verification.ok) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "STAFF_UNAVAILABLE",
                        message: "Selected staff is no longer available.",
                        traceId: activeTraceId
                    }
                };
            }

            rawSlot = verification.slot;
        } else if (!rawSlot) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available."
                }
            };
        }

        const normalizedSlot = _attachServiceId(
            rawSlot,
            resolvedServiceId,
            activeTraceId,
            "revalidateExactAvailabilitySlot"
        );

        const availableResourceIds = _getResourceIdsFromSlot(normalizedSlot);

        if (
            !normalizedSlot ||
            normalizedSlot.bookable !== true ||
            availableResourceIds.length === 0
        ) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available."
                }
            };
        }

        if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_UNAVAILABLE",
                    message: "Selected staff is no longer available."
                }
            };
        }

        if (earlyServiceConfig?.status === "SUCCESS" && earlyServiceConfig?.data) {
            const config = earlyServiceConfig.data;
            const startUtc = getUtcDateFromMadridLocal(start);
            const endUtc = getUtcDateFromMadridLocal(end);
            const actualMinutes = _minutesBetweenUtcDates(startUtc, endUtc);
            const durationRange = config.durationRange;

            if (durationRange && actualMinutes > 0) {
                const { min, max } = durationRange;
                const belowMin = min > 0 && actualMinutes < min;
                const aboveMax = max !== Infinity && actualMinutes > max;

                if (belowMin || aboveMax) {
                    return {
                        status: "ERROR",
                        data: null,
                        error: {
                            code: "SLOT_DURATION_OUT_OF_RANGE",
                            message: "Selected slot duration is out of the allowed range.",
                            traceId: activeTraceId
                        }
                    };
                }
            } else {
                const expectedMinutes = resolveExpectedSlotMinutes(config);

                if (expectedMinutes > 0 && actualMinutes > 0) {
                    if (Math.abs(actualMinutes - expectedMinutes) > 1) {
                        return {
                            status: "ERROR",
                            data: null,
                            error: {
                                code: "SLOT_DURATION_MISMATCH",
                                message: "Selected slot duration does not match service configuration.",
                                traceId: activeTraceId
                            }
                        };
                    }
                }
            }
        }

        let balancedResourceId = requiredResourceId || null;

        if (!balancedResourceId && availableResourceIds.length === 1) {
            balancedResourceId = availableResourceIds[0];
        } else if (!balancedResourceId && availableResourceIds.length > 1) {
            const dayKey = _safeTrim(start).slice(0, 10);
            const loadMap = await _countStaffLoadForDay(
                dayKey,
                availableResourceIds,
                activeTraceId
            );
            balancedResourceId =
                pickStaffByLowestLoad(availableResourceIds, loadMap) ||
                availableResourceIds.slice().sort()[0];
        }

        return {
            status: "SUCCESS",
            data: {
                slot: {
                    ...normalizedSlot,
                    localStartDate: start,
                    localEndDate: end
                },
                resourceId: balancedResourceId,
                candidateResourceIds: availableResourceIds
            },
            error: null
        };
    } catch (error) {
        log.warn("Exact slot revalidation failed", {
            traceId: activeTraceId,
            serviceId: String(resolvedServiceId),
            start,
            end,
            message: error?.message
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SLOT_UNAVAILABLE",
                message: "Selected slot could not be revalidated.",
                traceId: activeTraceId
            }
        };
    }
}