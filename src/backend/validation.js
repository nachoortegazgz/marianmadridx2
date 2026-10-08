/*
=============================================================================
MODULE: backend/validation.js
VERSION: v11.0-SSOT-CLEAN
BASE: BIBLIA v10.0 §6.5 + §12
RESPONSIBILITY: Validacion centralizada. Sin bloqueos innecesarios.
STANDARDS: G10 ASCII Strict. No console.log. No secretos.
=============================================================================
*/

import { logger } from "backend/logger";
import {
    BOOKING_STATUS,
    PAYMENT_STATUS,
    BOOKING_TYPE,
    INVENTORY_MOVEMENT_TYPE,
    MAGNITUDE,
    NEGATIVE_INVENTORY_MOVEMENT_TYPES,
    POSITIVE_INVENTORY_MOVEMENT_TYPES,
    CONTROL_TYPE,
    CONTROL_STATUS,
    COMPENSATION_KIND,
    CLOCK_EVENT_TYPE,
    RECORD_TYPE_HORARIOS,
    ITEM_NATURE,
    CATALOG_STATES,
    CASH_REGISTER_STATUS,
    ROL_BOOKINGS,
    ROL_WEBSITE,
    RECORD_TYPE,
    THIRD_PARTY_TYPE,
    CODIGO_IMPUESTO,
    TIPO_IMPOSITIVO_VALIDOS,
    CHANNEL_TYPE,
    MOVEMENT_TYPE,
    PAYMENT_METHOD,
    normalizeBookingType,
    isDualBookingType,
    isValidGuid,
} from "backend/internalConfig";

const log = logger;

// =============================================================================
// BLOQUE 1 - GENERIC ENUM ASSERTION (BIBLIA §6.5)
// =============================================================================

export function assertValidEnum(value, enumObject, fieldName) {
    const allowed = Object.values(enumObject);
    if (value === undefined || value === null || !allowed.includes(value)) {
        throw new Error(
            `SCHEMA_VIOLATION: ${fieldName}="${String(value)}" not in [${allowed.join(", ")}]`
        );
    }
    return value;
}

function _nonEmpty(v) {
    return typeof v === "string" && v.trim().length > 0;
}

// =============================================================================
// BLOQUE 2 - CitasF2 ASSERTION (BIBLIA §12.2)
// =============================================================================

export function assertCitasF2(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: CitasF2 item must be an object");
    }

    assertValidEnum(item.bookingStatus, BOOKING_STATUS, "bookingStatus");
    assertValidEnum(item.paymentStatus, PAYMENT_STATUS, "paymentStatus");

    const canonicalBookingType = normalizeBookingType(item.bookingType);
    assertValidEnum(canonicalBookingType, BOOKING_TYPE, "bookingType");

    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2 requires traceId");
    }
    if (!_nonEmpty(item.bookingId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2 requires bookingId");
    }
    if (!isValidGuid(item.bookingId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2.bookingId must be a valid GUID");
    }

    if (isDualBookingType(canonicalBookingType) && !_nonEmpty(item.pairToken)) {
        throw new Error("SCHEMA_VIOLATION: DUAL requires pairToken");
    }

    return true;
}

// =============================================================================
// BLOQUE 3 - MapaStaff ASSERTION (BIBLIA §5.9)
// =============================================================================

export function assertRolBookings(value) {
    return assertValidEnum(value, ROL_BOOKINGS, "rolBookings");
}

export function assertRolWebsite(value) {
    return assertValidEnum(value, ROL_WEBSITE, "rolWebsite");
}

export function assertMapaStaff(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: MapaStaff item must be an object");
    }

    if (!_nonEmpty(item.memberId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requires memberId");
    }
    if (!isValidGuid(item.memberId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff.memberId must be a valid GUID");
    }
    if (!_nonEmpty(item.resourceId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requires resourceId");
    }
    if (!isValidGuid(item.resourceId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff.resourceId must be a valid GUID");
    }

    assertRolBookings(item.rolBookings);
    assertRolWebsite(item.rolWebsite);

    if (!_nonEmpty(item.staffName)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requires staffName");
    }
    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requires traceId");
    }

    return true;
}

// =============================================================================
// BLOQUE 4 - ServiciosCatalogo ASSERTION (BIBLIA §5.7)
// SIN BLOQUEOS INNecesarios:
//   - mainMedia: acepta URL texto O objeto Image (pendiente ADR)
//   - locationId: acepta texto plano (estado real del CMS)
//   - status: NO se valida (pendiente ADR)
//   - Campo 'active': prohibido (eliminado globalmente)
// =============================================================================

export function assertServiciosCatalogo(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo item must be an object");
    }

    if (!_nonEmpty(item.serviceId) || !isValidGuid(item.serviceId)) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo.serviceId must be a valid GUID");
    }
    if (!_nonEmpty(item.slug)) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo requires slug");
    }
    if (!_nonEmpty(item.sku)) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo requires sku");
    }

    // status: NO se valida. Pendiente ADR (BIBLIA §6.4).
    // Se acepta cualquier valor existente en el CMS.

    if (item.itemNature !== undefined) {
        assertValidEnum(item.itemNature, ITEM_NATURE, "itemNature");
    }

    // Fiscal: tipoImpositivo obligatorio si presente
    if (item.tipoImpositivo !== undefined) {
        if (!TIPO_IMPOSITIVO_VALIDOS.includes(Number(item.tipoImpositivo))) {
            throw new Error(
                "SCHEMA_VIOLATION: tipoImpositivo must be one of [0, 0.04, 0.10, 0.21]"
            );
        }
    }
    if (item.codigoImpuesto !== undefined) {
        assertValidEnum(item.codigoImpuesto, CODIGO_IMPUESTO, "codigoImpuesto");
    }

    // Duraciones: suma exacta solo si allowCombine
    const phase1 = Number(item.phase1Duration) || 0;
    const exposure = Number(item.exposureDuration) || 0;
    const phase2 = Number(item.phase2Duration) || 0;
    const total = Number(item.totalDuration);

    if (item.allowCombine === true) {
        const expected = phase1 + exposure + phase2;
        if (Math.abs(total - expected) > 0.001) {
            throw new Error(
                `SCHEMA_VIOLATION: totalDuration (${total}) must equal phase1+exposure+phase2 (${expected})`
            );
        }
        if (exposure > 120) {
            throw new Error("SCHEMA_VIOLATION: exposureDuration must be <= 120 minutes");
        }
    }

    // linkedPhases: GUID valido, nunca slug
    if (_nonEmpty(item.linkedPhases)) {
        const linked = Array.isArray(item.linkedPhases)
            ? item.linkedPhases
            : [item.linkedPhases];
        for (const lp of linked) {
            const id = typeof lp === "object" ? lp?._id || lp?.id : lp;
            if (!isValidGuid(String(id))) {
                throw new Error("SCHEMA_VIOLATION: linkedPhases must be a valid GUID");
            }
        }
    }

    // locationId: acepta texto plano (estado real del CMS - BIBLIA §5.7 nota 4)
    // NO se exige Multi Reference hasta migracion efectiva.
    if (item.locationId !== undefined && item.locationId !== null) {
        const locStr = String(item.locationId).trim();
        if (locStr && !isValidGuid(locStr)) {
            log.warn("locationId is not a valid GUID, accepting as-is", {
                locationId: locStr,
            });
        }
    }

    // mainMedia: acepta URL de texto O objeto Image (BIBLIA §5.7 nota 2)
    // Pendiente ADR. No bloquear ninguna forma durante transicion.
    // Sin validacion restrictiva.

    // Campo 'active' prohibido (eliminado globalmente)
    if ("active" in item) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo.active prohibido");
    }

    return true;
}

// =============================================================================
// BLOQUE 5 - DatosFiscales ASSERTION
// =============================================================================

const NIF_LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";

export function isValidNifEspanol(nif) {
    const clean = String(nif ?? "").trim().toUpperCase().replace(/[-\s]/g, "");
    if (!clean || clean.length < 8) return false;

    if (/^\d{8}[A-Z]$/.test(clean)) {
        const numero = Number(clean.slice(0, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
        const prefijo = { X: "0", Y: "1", Z: "2" }[clean.charAt(0)];
        const numero = Number(prefijo + clean.slice(1, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    if (/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(clean)) {
        return true;
    }

    return false;
}

export function isValidNifOrEuVat(nif) {
    const clean = String(nif ?? "").trim().toUpperCase().replace(/[-\s]/g, "");
    if (!clean) return false;
    if (isValidNifEspanol(clean)) return true;
    if (clean.length >= 8 && clean.length <= 14) {
        const prefix = clean.slice(0, 2);
        const body = clean.slice(2);
        if (
            ["AT","BE","BG","CY","CZ","DE","DK","EE","EL","ES","FI","FR","HR","HU",
             "IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"]
                .includes(prefix) &&
            /^[A-Z0-9]{5,12}$/.test(body)
        ) {
            return true;
        }
    }
    return false;
}

export function assertDatosFiscales(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: DatosFiscales item must be an object");
    }

    assertValidEnum(item.recordType, RECORD_TYPE, "recordType");

    if (!_nonEmpty(item.taxId) || !isValidNifOrEuVat(item.taxId)) {
        throw new Error("SCHEMA_VIOLATION: DatosFiscales.taxId must be valid NIF/NIE/CIF/VAT-UE");
    }
    if (!_nonEmpty(item.legalName)) {
        throw new Error("SCHEMA_VIOLATION: DatosFiscales requires legalName");
    }

    assertValidEnum(item.thirdPartyType, THIRD_PARTY_TYPE, "thirdPartyType");

    if (item.thirdPartyType === THIRD_PARTY_TYPE.STAFF) {
        if (!_nonEmpty(item.bookingsResourceId) || !isValidGuid(item.bookingsResourceId)) {
            throw new Error("SCHEMA_VIOLATION: STAFF requires bookingsResourceId GUID");
        }
        if (!_nonEmpty(item.memberId)) {
            throw new Error("SCHEMA_VIOLATION: STAFF requires memberId");
        }
    }

    if ("active" in item) {
        throw new Error("SCHEMA_VIOLATION: DatosFiscales.active prohibido");
    }

    return true;
}

// =============================================================================
// BLOQUE 6 - ControlOperativo ASSERTION
// =============================================================================

export function assertControlOperativo(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: ControlOperativo item must be an object");
    }

    assertValidEnum(item.controlType, CONTROL_TYPE, "controlType");

    if (!_nonEmpty(item.dedupeKey)) {
        throw new Error("SCHEMA_VIOLATION: ControlOperativo requires dedupeKey");
    }
    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: ControlOperativo requires traceId");
    }

    if (item.status !== undefined && item.status !== null) {
        assertValidEnum(item.status, CONTROL_STATUS, "status");
    }

    if (item.controlType === CONTROL_TYPE.WEBHOOK_EVENT && !_nonEmpty(item.eventId)) {
        throw new Error("SCHEMA_VIOLATION: WEBHOOK_EVENT requires eventId");
    }

    const ttlTypes = [CONTROL_TYPE.SLOT_LOCK, CONTROL_TYPE.RATE_LIMIT];
    if (ttlTypes.includes(item.controlType) && !item.expiresAt) {
        throw new Error(`SCHEMA_VIOLATION: ${item.controlType} requires expiresAt`);
    }

    if (item.controlType === "COMPENSATION" && item.kind !== undefined) {
        assertValidEnum(item.kind, COMPENSATION_KIND, "kind");
    }

    return true;
}

// =============================================================================
// BLOQUE 7 - RegistrosHorariosStaff ASSERTION (RD 8/2019)
// =============================================================================

export function assertRegistrosHorariosStaff(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: RegistrosHorariosStaff item must be an object");
    }

    assertValidEnum(item.clockEventType, CLOCK_EVENT_TYPE, "clockEventType");
    assertValidEnum(item.recordType, RECORD_TYPE_HORARIOS, "recordType");

    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: RegistrosHorariosStaff requires traceId");
    }
    if (!_nonEmpty(item.resourceId) || !isValidGuid(item.resourceId)) {
        throw new Error("SCHEMA_VIOLATION: RegistrosHorariosStaff.resourceId must be valid GUID");
    }
    if (!_nonEmpty(item.memberId)) {
        throw new Error("SCHEMA_VIOLATION: RegistrosHorariosStaff requires memberId");
    }

    if (
        (item.recordType === RECORD_TYPE_HORARIOS.AJUSTE ||
            item.clockEventType === CLOCK_EVENT_TYPE.AJUSTE) &&
        !_nonEmpty(item.adjustmentReason)
    ) {
        throw new Error("SCHEMA_VIOLATION: AJUSTE requires adjustmentReason (RD 8/2019)");
    }

    if (!item.recordedAt || isNaN(new Date(item.recordedAt).getTime())) {
        throw new Error("SCHEMA_VIOLATION: RegistrosHorariosStaff.recordedAt must be valid");
    }

    return true;
}

// =============================================================================
// BLOQUE 8 - MovimientosInventario ASSERTION
// =============================================================================

export function assertMovimientosInventario(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: MovimientosInventario item must be an object");
    }

    assertValidEnum(item.movementType, INVENTORY_MOVEMENT_TYPE, "movementType");

    if (!_nonEmpty(item.movementToken)) {
        throw new Error("SCHEMA_VIOLATION: MovimientosInventario requires movementToken");
    }
    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: MovimientosInventario requires traceId");
    }
    if (!_nonEmpty(item.sku)) {
        throw new Error("SCHEMA_VIOLATION: MovimientosInventario requires sku");
    }

    if (item.movementType === INVENTORY_MOVEMENT_TYPE.AJUSTE && !_nonEmpty(item.operationDescription)) {
        throw new Error("SCHEMA_VIOLATION: AJUSTE requires operationDescription");
    }

    const delta = Number(item.quantityDelta);
    if (!Number.isFinite(delta) || delta === 0) {
        throw new Error("SCHEMA_VIOLATION: quantityDelta cannot be 0");
    }

    return true;
}

export function expectedInventoryMagnitude(movementType, quantityDelta) {
    if (POSITIVE_INVENTORY_MOVEMENT_TYPES.includes(movementType)) return MAGNITUDE.POSITIVE;
    if (NEGATIVE_INVENTORY_MOVEMENT_TYPES.includes(movementType)) return MAGNITUDE.NEGATIVE;
    const d = Number(quantityDelta);
    if (Number.isFinite(d) && d > 0) return MAGNITUDE.POSITIVE;
    if (Number.isFinite(d) && d < 0) return MAGNITUDE.NEGATIVE;
    return MAGNITUDE.NEUTRAL;
}

// =============================================================================
// BLOQUE 9 - DOMAIN ENUM ASSERTIONS
// =============================================================================

export function assertMovementType(value) {
    return assertValidEnum(value, MOVEMENT_TYPE, "movementType");
}

export function assertPaymentMethod(value) {
    return assertValidEnum(value, PAYMENT_METHOD, "paymentMethod");
}

export function assertChannelType(value) {
    return assertValidEnum(value, CHANNEL_TYPE, "channelType");
}

export function assertItemNature(value) {
    return assertValidEnum(value, ITEM_NATURE, "itemNature");
}

export function assertCashRegisterStatus(value) {
    return assertValidEnum(value, CASH_REGISTER_STATUS, "cashRegisterStatus");
}

export function assertCatalogStatus(value) {
    return assertValidEnum(value, CATALOG_STATES, "status");
}

export function assertCompensationKind(value) {
    return assertValidEnum(value, COMPENSATION_KIND, "kind");
}

export function assertControlType(value) {
    return assertValidEnum(value, CONTROL_TYPE, "controlType");
}

export function assertClockEventType(value) {
    return assertValidEnum(value, CLOCK_EVENT_TYPE, "clockEventType");
}
