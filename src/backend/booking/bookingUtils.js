/*
=============================================================================
MODULE: backend/booking/bookingUtils.js
VERSION: v5009-FISCAL-V20.1
BASE: v5008.3-FINAL + Directriz V20 (IDs nativa en ingles)
STANDARDS: G10 ASCII Strict

RESPONSIBILITY: Helpers compartidos entre reservas, citas, bookingSaga y
                bookingCore. Utilidades puras. Sin acceso a colecciones CMS.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin cambios funcionales. El modulo no importa constantes de
            internalConfig.js ni accede a campos CMS. Cabecera actualizada
            para trazabilidad.

FIXES APLICADOS v5008.3 (heredados):
  - FIX-18: cleanGuid, cleanGuidList.
  - FIX-26: numberOrZero, booleanValue.
  - FIX-16: toUtcRange.
  - FIX-17: validateSlotDuration.
  - FIX-R2: pickStaffByLowestLoad (balanceo de carga staff).
=============================================================================
*/

import {
    _safeTrim,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - GUID Y COERCION
// =============================================================================

export function cleanGuid(value, errorCode = "INVALID_GUID") {
    const clean = _safeTrim(value);

    if (!clean || !_looksLikeGuid(clean)) {
        throw new Error(`${errorCode}: GUID invalido o ausente`);
    }

    return clean;
}

export function cleanGuidList(value) {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];

    return Array.from(
        new Set(
            source
                .map((item) => {
                    if (typeof item === "string") {
                        return _safeTrim(item);
                    }

                    return _safeTrim(
                        item?.resourceId ||
                        item?.id ||
                        item?._id
                    );
                })
                .filter((id) => _looksLikeGuid(id))
        )
    );
}

// =============================================================================
// BLOQUE 1B - HELPERS CANONICOS DE SLOT Y PAIR TOKEN
// (v5010.4 FASE 2: cero duplicado, cero ciclos de import)
//
// Unicas implementaciones de:
//   - normalizacion de forma de slot (normalizeSlotShape)
//   - extraccion de resourceIds de staff (getResourceIdsFromSlot)
//   - huella canonica del par dual (_buildPairFingerprint) [CORE-05]
//
// Precedencia de modulo segun regla FASE 2:
//   mmUtils > bookingUtils > core > web.
// Por eso la huella vive AQUI (capa utilidades puras), no en bookingCore:
// bookingCore ya depende de bookingUtils; definir la huella en bookingCore
// obligaria a un import bookingUtils -> bookingCore (CICLO real). Todos los
// consumidores (bookingCore, reservas.web, bookingSaga) importan de aqui o
// reciben la reexportacion canonica de bookingCore.
// =============================================================================

/**
 * CORE-05 / SAGA-02 / PATCH-02: UNICA fuente de verdad de la huella del par
 * dual. Debe ser IDENTICA en los tres puntos donde se genera o consume un
 * pairToken:
 *   1. reservas.web._getCertifiedDualSlotsInternal (emisor en disponibilidad)
 *   2. bookingSaga._resolveUnifiedPairToken        (consumidor/reemisor)
 *   3. DualSlotCache.pairToken                     (persistencia)
 * Cualquier cambio en el orden o contenido de los campos rompe la correlacion
 * y la idempotencia. Los 8 campos son obligatorios por contrato (los
 * opcionales se serializan como cadena vacia).
 */
export function _buildPairFingerprint({
    serviceId,
    linkedPhases,
    dateYmd,
    f1Start,
    f1End,
    f2Start,
    f2End,
    resourceId,
} = {}) {
    return [
        _safeTrim(serviceId) || "",
        _safeTrim(linkedPhases) || "",
        _safeTrim(dateYmd) || "",
        _safeTrim(f1Start) || "",
        _safeTrim(f1End) || "",
        _safeTrim(f2Start) || "",
        _safeTrim(f2End) || "",
        _safeTrim(resourceId) || "",
    ].join("|");
}

/**
 * Normaliza la forma de un slot Time Slots V2: si llega envuelto en
 * { slot: {...} }, fusiona el slot interno con el contenedor (el contenedor
 * manda). Idempotente sobre slots ya planos.
 */
export function normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return { ...slot.slot, ...slot };
    }
    return slot;
}

/**
 * Extrae los resourceIds GUID del grupo de staff de un slot (formato plano o
 * envuelto), deduplicados. Fallback: resource directo / resourceId plano.
 * @param {object} slot slot crudo o normalizado
 * @param {string} staffResourceTypeId id del tipo de recurso STAFF (API.*)
 */
export function getResourceIdsFromSlot(slot, staffResourceTypeId) {
    const normalizedSlot = normalizeSlotShape(slot);
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
        const staffGroup = groups.find((group) => {
            const typeId =
                group?.resourceTypeId ||
                group?.resourceType?.id ||
                group?.resourceType?._id ||
                group?.typeId;

            return String(typeId) === String(staffResourceTypeId);
        });

        if (staffGroup) {
            return Array.from(
                new Set(
                    (staffGroup.resources || [])
                        .map((resource) =>
                            _safeTrim(
                                resource?.id || resource?._id || resource?.resourceId
                            )
                        )
                        .filter((resourceId) => _looksLikeGuid(resourceId))
                )
            );
        }
    }

    const directId = _safeTrim(
        normalizedSlot.resource?.id ||
        normalizedSlot.resource?._id ||
        normalizedSlot.resource?.resourceId ||
        normalizedSlot.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

export function numberOrZero(value) {
    const number = Number(value);

    return Number.isFinite(number) && number >= 0
        ? number
        : 0;
}

export function booleanValue(...values) {
    return values.some((value) => value === true);
}

// =============================================================================
// BLOQUE 2 - GAP Y UTC RANGES
// =============================================================================

export function computeGapMinutes(f1EndUtc, f2StartUtc) {
    if (
        !(f1EndUtc instanceof Date) ||
        !(f2StartUtc instanceof Date)
    ) {
        return 0;
    }

    const milliseconds =
        f2StartUtc.getTime() - f1EndUtc.getTime();

    return Math.max(
        0,
        Math.round(milliseconds / 60000)
    );
}

export function toUtcRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(startLocal)
    );

    const endUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(endLocal)
    );

    if (!startUtc || !endUtc) {
        return null;
    }

    if (endUtc.getTime() <= startUtc.getTime()) {
        return null;
    }

    return { startUtc, endUtc };
}

// =============================================================================
// BLOQUE 3 - DURATION RANGE
// =============================================================================

export function readDurationRange(item) {
    const constraints =
        item?.availabilityConstraints ||
        item?.data?.availabilityConstraints ||
        item?.fields?.availabilityConstraints;

    const range =
        constraints?.durationRange ||
        item?.durationRange ||
        item?.data?.durationRange ||
        item?.fields?.durationRange;

    if (!range || typeof range !== "object") {
        return null;
    }

    const min = Number(
        range.minDuration ??
        range.min ??
        0
    ) || 0;

    const rawMax = Number(
        range.maxDuration ??
        range.max ??
        0
    ) || 0;

    const max = rawMax > 0 ? rawMax : Infinity;

    if (min <= 0 && max === Infinity) {
        return null;
    }

    if (max !== Infinity && max <= min) {
        return null;
    }

    return { min, max };
}

// =============================================================================
// BLOQUE 4 - DURACION EFECTIVA
// =============================================================================

export function resolveExpectedSlotMinutes(serviceConfig) {
    if (!serviceConfig) {
        return 0;
    }

    if (serviceConfig.allowCombine === true) {
        return Number(
            serviceConfig.phase1Duration || 0
        ) || 0;
    }

    return (
        Number(serviceConfig.phase1Duration || 0) ||
        Number(serviceConfig.totalDuration || 0) ||
        Number(
            serviceConfig.metadata?.timing?.estimatedTotal || 0
        ) ||
        0
    );
}

export async function resolveLinkedPhase2Duration(
    linkedServiceId,
    traceId,
    visited = new Set(),
    resolver
) {
    const linkedId = _safeTrim(linkedServiceId);

    if (
        !_looksLikeGuid(linkedId) ||
        typeof resolver !== "function"
    ) {
        return 0;
    }

    if (visited.has(linkedId)) {
        log.warn(
            "Cycle detected in linkedPhases chain",
            { traceId, linkedId, visited: Array.from(visited) }
        );
        return 0;
    }

    visited.add(linkedId);

    const result = await resolver(
        linkedId,
        traceId
    );

    if (
        result?.status !== "SUCCESS" ||
        !result?.data
    ) {
        return 0;
    }

    const service = result.data;

    return (
        Number(service.phase1Duration || 0) ||
        Number(service.totalDuration || 0) ||
        Number(service.metadata?.timing?.estimatedTotal || 0) ||
        0
    );
}

// =============================================================================
// BLOQUE 5 - VALIDACION DE DURACION DE SLOT
// =============================================================================

export function validateSlotDuration({
    serviceConfig,
    startLocal,
    endLocal,
}) {
    const result = {
        ok: true,
        code: null,
        actualMinutes: 0,
        expectedMinutes: null,
        min: null,
        max: null,
    };

    if (!serviceConfig || typeof serviceConfig !== "object") {
        return result;
    }

    const startUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(startLocal)
    );

    const endUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(endLocal)
    );

    if (!startUtc || !endUtc) {
        return result;
    }

    const diffMs = endUtc.getTime() - startUtc.getTime();

    if (!Number.isFinite(diffMs) || diffMs <= 0) {
        return result;
    }

    const actualMinutes = Math.round(diffMs / 60000);

    result.actualMinutes = actualMinutes;

    const durationRange = serviceConfig.durationRange;

    if (durationRange) {
        const { min, max } = durationRange;

        result.min = min;
        result.max = max === Infinity ? null : max;

        const belowMin = min > 0 && actualMinutes < min;
        const aboveMax = max !== Infinity && actualMinutes > max;

        if (belowMin || aboveMax) {
            result.ok = false;
            result.code = "SLOT_DURATION_OUT_OF_RANGE";
        }

        return result;
    }

    const expectedMinutes =
        resolveExpectedSlotMinutes(serviceConfig);

    if (expectedMinutes > 0) {
        result.expectedMinutes = expectedMinutes;

        if (Math.abs(actualMinutes - expectedMinutes) > 1) {
            result.ok = false;
            result.code = "SLOT_DURATION_MISMATCH";
        }
    }

    return result;
}

// =============================================================================
// BLOQUE 6 - [FIX-R2] BALANCEO DE CARGA DE STAFF
//
// Elige el recurso con menor carga del mapa loadByResource. En empates,
// orden alfabetico determinista. Si el mapa esta vacio, primer alfabetico.
//
// Uso: reservas.web.js (dual), revalidateExactAvailabilitySlot cuando no
// hay requiredResourceId y hay multiples candidatos.
// =============================================================================

export function pickStaffByLowestLoad(candidates, loadByResource) {
    const ids = Array.isArray(candidates)
        ? Array.from(
            new Set(
                candidates
                    .map((id) => _safeTrim(id))
                    .filter((id) => _looksLikeGuid(id))
            )
        )
        : [];

    if (ids.length === 0) {
        return null;
    }

    const loadMap =
        loadByResource && typeof loadByResource === "object"
            ? loadByResource
            : {};

    const sorted = ids.slice().sort((a, b) => a.localeCompare(b));

    let best = sorted[0];
    let bestLoad = Number(loadMap[best] || 0);

    for (let i = 1; i < sorted.length; i += 1) {
        const id = sorted[i];
        const load = Number(loadMap[id] || 0);

        if (load < bestLoad) {
            best = id;
            bestLoad = load;
        }
    }

    return best;
}