/*
=============================================================================
MODULE: backend/validation.js
VERSION: v8.1-SSOT-MASTER
BASE: BIBLIA v8.0 §13.1 + ANEXO SSOT v8.1 (C-01 a C-07)
RESPONSIBILITY: Validacion centralizada de enums, aserciones estructurales
                y normalizacion READ-ONLY de estados legacy (EOL 31/12/2026).
STANDARDS: G10 ASCII Strict. No console.log. No secretos.

CORRECTIONS APPLIED (ANEXO v8.1):
  - C-02: assertMapaStaff valida rolBookings + rolWebsite
  - C-03: assertMapaStaff valida memberId (no staffMemberId)
  - C-05: assertServiciosCatalogo valida locationId Multi Reference
  - C-06: assertServiciosCatalogo valida mainMedia Image
  - ADR-17: BOOKING_TYPE.DUAL_F1/DUAL_F2 (SNAKE_CASE)
  - SSOT-07: Validacion runtime centralizada obligatoria
=============================================================================
*/

import { logger } from "backend/logger";
import {
    BOOKING_STATUS,
    BOOKING_TYPE,
    PAYMENT_STATUS,
    PAYMENT_METHOD,
    MOVEMENT_TYPE,
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
    normalizeBookingType,
    isDualBookingType,
    isValidGuid,
} from "backend/internalConfig";

const log = logger;

// =============================================================================
// BLOQUE 1 - GENERIC ENUM ASSERTION (BIBLIA 9.4 / SSOT-07)
// =============================================================================

export function assertValidEnum(value, enumObject, fieldName) {
    const allowed = Object.values(enumObject);
    if (value === undefined || value === null || !allowed.includes(value)) {
        throw new Error(
            `SCHEMA_VIOLATION: ${fieldName}="${String(value)}" not in canonical enum [${allowed.join(", ")}]`
        );
    }
    return value;
}

function _nonEmpty(v) {
    return typeof v === "string" && v.trim().length > 0;
}

function _canonicalKey(value) {
    return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// =============================================================================
// BLOQUE 2 - READ-ONLY NORMALIZERS (EOL 31/12/2026, BIBLIA 17)
// Nunca inventan datos: valores desconocidos pasan intactos para que
// assertValidEnum falle ruidosamente.
// =============================================================================

const PAYMENT_LEGACY_MAP = Object.freeze({
    UNPAID: PAYMENT_STATUS.NOT_PAID,
    NOPAGADO: PAYMENT_STATUS.NOT_PAID,
    NO_PAGADO: PAYMENT_STATUS.NOT_PAID,
    PAGADO: PAYMENT_STATUS.PAID,
    PENDIENTEPAGO: PAYMENT_STATUS.PENDING_PAYMENT,
    PENDIENTE_PAGO: PAYMENT_STATUS.PENDING_PAYMENT,
    PENDIENTEASIENTO: PAYMENT_STATUS.PENDING_LEDGER,
    PENDIENTE_ASIENTO: PAYMENT_STATUS.PENDING_LEDGER,
    REEMBOLSADO: PAYMENT_STATUS.REFUNDED,
    REEMBOLSADOPARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
    REEMBOLSADO_PARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
    EXENTO: PAYMENT_STATUS.EXEMPT,
});

const BOOKING_LEGACY_MAP = Object.freeze({
    CONFIRMADO: BOOKING_STATUS.CONFIRMED,
    CANCELADO: BOOKING_STATUS.CANCELED,
    REEMBOLSADO: BOOKING_STATUS.REFUNDED,
    PENDIENTE: BOOKING_STATUS.PENDING,
    CREADA: BOOKING_STATUS.CREATED,
    RECHAZADA: BOOKING_STATUS.DECLINED,
    LISTADEESPERA: BOOKING_STATUS.WAITING_LIST,
    ACTUALIZADA: BOOKING_STATUS.UPDATED,
});

export function normalizePaymentStatus(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return s;
    const direct = Object.values(PAYMENT_STATUS);
    if (direct.includes(s)) return s;
    const mapped = PAYMENT_LEGACY_MAP[_canonicalKey(s)];
    if (mapped !== undefined) {
        log.warn("legacy paymentStatus normalized on read", {
            raw: s,
            canonical: mapped,
        });
        return mapped;
    }
    return s;
}

export function normalizeBookingStatus(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return s;
    const direct = Object.values(BOOKING_STATUS);
    if (direct.includes(s)) return s;
    const mapped = BOOKING_LEGACY_MAP[_canonicalKey(s)];
    if (mapped !== undefined) {
        log.warn("legacy bookingStatus normalized on read", {
            raw: s,
            canonical: mapped,
        });
        return mapped;
    }
    return s;
}

// =============================================================================
// BLOQUE 3 - CitasF2 ASSERTION (BIBLIA 13.2 / hooks)
// =============================================================================

export function assertCitasF2(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: CitasF2 item must be an object");
    }

    assertValidEnum(
        normalizeBookingStatus(item.bookingStatus),
        BOOKING_STATUS,
        "bookingStatus"
    );
    assertValidEnum(
        normalizePaymentStatus(item.paymentStatus),
        PAYMENT_STATUS,
        "paymentStatus"
    );

    // ADR-17: canonical SNAKE_CASE (DUAL_F1/DUAL_F2)
    const canonicalBookingType = normalizeBookingType(item.bookingType);
    assertValidEnum(canonicalBookingType, BOOKING_TYPE, "bookingType");

    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2 requires traceId (SSOT-12)");
    }
    if (!_nonEmpty(item.bookingId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2 requires bookingId");
    }
    if (!isValidGuid(item.bookingId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2.bookingId must be a valid GUID");
    }

    const isDual = isDualBookingType(canonicalBookingType);
    if (isDual && !_nonEmpty(item.pairToken)) {
        throw new Error(
            "SCHEMA_VIOLATION: DUAL_F1/DUAL_F2 requires pairToken (BIBLIA 16.2)"
        );
    }

    return true;
}

// =============================================================================
// BLOQUE 4 - MapaStaff ASSERTION (ANEXO v8.1 C-02/C-03)
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

    // C-03: memberId (no staffMemberId)
    if (!_nonEmpty(item.memberId)) {
        throw new Error(
            "SCHEMA_VIOLATION: MapaStaff requires memberId (ANEXO v8.1 C-03)"
        );
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

    // C-02: rolBookings + rolWebsite (no staffRole)
    assertRolBookings(item.rolBookings);
    assertRolWebsite(item.rolWebsite);

    if (!_nonEmpty(item.staffName)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requires staffName");
    }
    if (String(item.staffName).length > 100) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff.staffName max 100 chars");
    }

    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requires traceId (SSOT-12)");
    }

    // C-01: campo 'active' prohibido
    if ("active" in item) {
        throw new Error(
            "SCHEMA_VIOLATION: MapaStaff.active prohibido (ANEXO v8.1 C-01)"
        );
    }

    return true;
}

// =============================================================================
// BLOQUE 5 - ServiciosCatalogo ASSERTION (ANEXO v8.1 C-05/C-06)
// =============================================================================

export function assertServiciosCatalogo(item) {
    if (!item || typeof item !== "object") {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo item must be an object");
    }

    if (!_nonEmpty(item.serviceId) || !isValidGuid(item.serviceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: ServiciosCatalogo.serviceId must be a valid GUID"
        );
    }
    if (!_nonEmpty(item.slug)) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo requires slug");
    }
    if (!_nonEmpty(item.sku)) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo requires sku");
    }

    assertValidEnum(item.status, CATALOG_STATES, "status");
    assertValidEnum(item.itemNature, ITEM_NATURE, "itemNature");

    // Par fiscal obligatorio
    if (
        item.tipoImpositivo !== undefined &&
        !TIPO_IMPOSITIVO_VALIDOS.includes(Number(item.tipoImpositivo))
    ) {
        throw new Error(
            "SCHEMA_VIOLATION: tipoImpositivo must be one of [0, 0.04, 0.10, 0.21]"
        );
    }
    if (item.codigoImpuesto !== undefined) {
        assertValidEnum(item.codigoImpuesto, CODIGO_IMPUESTO, "codigoImpuesto");
    }

    // Duraciones: suma exacta sin fallback (BIBLIA 2.1)
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
            throw new Error(
                "SCHEMA_VIOLATION: exposureDuration must be <= 120 minutes"
            );
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
                throw new Error(
                    "SCHEMA_VIOLATION: linkedPhases must be a valid GUID (never slug)"
                );
            }
        }
    }

    // C-05: locationId Multi Reference (array de GUIDs o refs Wix)
    if (item.locationId !== undefined && item.locationId !== null) {
        const locations = Array.isArray(item.locationId)
            ? item.locationId
            : [item.locationId];
        for (const loc of locations) {
            const locId = typeof loc === "object" ? loc?._id || loc?.id : loc;
            if (!_nonEmpty(String(locId ?? ""))) {
                throw new Error(
                    "SCHEMA_VIOLATION: locationId entries must be non-empty (ANEXO v8.1 C-05)"
                );
            }
        }
    }

    // C-06: mainMedia Image nativo Wix (objeto con src, no URL plana)
    if (item.mainMedia !== undefined && item.mainMedia !== null) {
        const media = item.mainMedia;
        const isImageObject =
            typeof media === "object" &&
            (_nonEmpty(media.src) || _nonEmpty(media._id) || _nonEmpty(media.fileId));
        if (!isImageObject) {
            throw new Error(
                "SCHEMA_VIOLATION: mainMedia must be a Wix Image object (ANEXO v8.1 C-06)"
            );
        }
    }

    // C-01: campo 'active' prohibido
    if ("active" in item) {
        throw new Error(
            "SCHEMA_VIOLATION: ServiciosCatalogo.active prohibido (ANEXO v8.1 C-01)"
        );
    }

    return true;
}

// =============================================================================
// BLOQUE 6 - DatosFiscales ASSERTION
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
        throw new Error(
            "SCHEMA_VIOLATION: DatosFiscales.taxId must be a valid NIF/NIE/CIF/VAT-UE"
        );
    }
    if (!_nonEmpty(item.legalName)) {
        throw new Error("SCHEMA_VIOLATION: DatosFiscales requires legalName");
    }

    assertValidEnum(item.thirdPartyType, THIRD_PARTY_TYPE, "thirdPartyType");

    if (item.thirdPartyType === THIRD_PARTY_TYPE.STAFF) {
        if (!_nonEmpty(item.bookingsResourceId) || !isValidGuid(item.bookingsResourceId)) {
            throw new Error(
                "SCHEMA_VIOLATION: thirdPartyType=STAFF requires bookingsResourceId GUID"
            );
        }
        // C-03: memberId (no staffMemberId)
        if (!_nonEmpty(item.memberId)) {
            throw new Error(
                "SCHEMA_VIOLATION: thirdPartyType=STAFF requires memberId (ANEXO v8.1 C-03)"
            );
        }
    }

    if ("active" in item) {
        throw new Error(
            "SCHEMA_VIOLATION: DatosFiscales.active prohibido (ANEXO v8.1 C-01)"
        );
    }

    return true;
}

// =============================================================================
// BLOQUE 7 - ControlOperativo ASSERTION
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
        throw new Error("SCHEMA_VIOLATION: ControlOperativo requires traceId (SSOT-12)");
    }

    if (item.status !== undefined && item.status !== null) {
        assertValidEnum(item.status, CONTROL_STATUS, "status");
    }

    if (item.controlType === CONTROL_TYPE.WEBHOOK_EVENT && !_nonEmpty(item.eventId)) {
        throw new Error(
            "SCHEMA_VIOLATION: WEBHOOK_EVENT requires eventId (ADR-05)"
        );
    }

    const ttlTypes = [
        CONTROL_TYPE.SLOT_LOCK,
        CONTROL_TYPE.RATE_LIMIT,
        CONTROL_TYPE.DAYS_CACHE,
        CONTROL_TYPE.DUAL_CACHE,
    ];
    if (ttlTypes.includes(item.controlType) && !item.expiresAt) {
        throw new Error(
            `SCHEMA_VIOLATION: ${item.controlType} requires expiresAt`
        );
    }

    if (item.controlType === CONTROL_TYPE.COMPENSATION && item.kind !== undefined) {
        assertValidEnum(item.kind, COMPENSATION_KIND, "kind");
    }

    return true;
}

// =============================================================================
// BLOQUE 8 - RegistrosHorariosStaff ASSERTION (ANEXO v8.1 C-04)
// =============================================================================

export function assertRegistrosHorariosStaff(item) {
    if (!item || typeof item !== "object") {
        throw new Error(
            "SCHEMA_VIOLATION: RegistrosHorariosStaff item must be an object"
        );
    }

    assertValidEnum(item.clockEventType, CLOCK_EVENT_TYPE, "clockEventType");
    assertValidEnum(item.recordType, RECORD_TYPE_HORARIOS, "recordType");

    if (!_nonEmpty(item.traceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: RegistrosHorariosStaff requires traceId (SSOT-12)"
        );
    }
    if (!_nonEmpty(item.resourceId) || !isValidGuid(item.resourceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: RegistrosHorariosStaff.resourceId must be a valid GUID"
        );
    }

    // C-04: memberId (no staffMemberId)
    if (!_nonEmpty(item.memberId)) {
        throw new Error(
            "SCHEMA_VIOLATION: RegistrosHorariosStaff requires memberId (ANEXO v8.1 C-04)"
        );
    }

    if (
        (item.recordType === RECORD_TYPE_HORARIOS.AJUSTE ||
            item.clockEventType === CLOCK_EVENT_TYPE.AJUSTE) &&
        !_nonEmpty(item.adjustmentReason)
    ) {
        throw new Error(
            "SCHEMA_VIOLATION: AJUSTE requires adjustmentReason (RD 8/2019)"
        );
    }

    if (!item.recordedAt || isNaN(new Date(item.recordedAt).getTime())) {
        throw new Error(
            "SCHEMA_VIOLATION: RegistrosHorariosStaff.recordedAt must be a valid timestamp"
        );
    }

    return true;
}

// =============================================================================
// BLOQUE 9 - MovimientosInventario ASSERTION (BIBLIA 13.1)
// =============================================================================

const INVENTORY_LEGACY_TYPE_MAP = Object.freeze({
    ENTRADA: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    SALIDA: INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
    STOCK_IN: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    STOCK_OUT: INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
    COMPRA: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    PURCHASE: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    SALE: INVENTORY_MOVEMENT_TYPE.VENTA,
    WASTE: INVENTORY_MOVEMENT_TYPE.AJUSTE,
    MERMA: INVENTORY_MOVEMENT_TYPE.AJUSTE,
    AJUSTE_POSITIVO: INVENTORY_MOVEMENT_TYPE.AJUSTE,
    AJUSTE_NEGATIVO: INVENTORY_MOVEMENT_TYPE.AJUSTE,
    TRASLADO_ENTRADA: INVENTORY_MOVEMENT_TYPE.TRANSFERENCIA,
    TRASLADO_SALIDA: INVENTORY_MOVEMENT_TYPE.TRANSFERENCIA,
    ONLINE_SALE: INVENTORY_MOVEMENT_TYPE.VENTA,
    VENTA_ONLINE: INVENTORY_MOVEMENT_TYPE.VENTA,
});

export function normalizeInventoryMovementType(raw) {
    const s = String(raw ?? "").trim().toUpperCase();
    if (!s) return s;
    const direct = Object.values(INVENTORY_MOVEMENT_TYPE);
    if (direct.includes(s)) return s;
    const mapped = INVENTORY_LEGACY_TYPE_MAP[_canonicalKey(s)];
    if (mapped !== undefined) {
        log.warn("legacy inventory movementType normalized on read", {
            raw: s,
            canonical: mapped,
        });
        return mapped;
    }
    return s;
}

export function expectedInventoryMagnitude(movementType, quantityDelta) {
    const t = normalizeInventoryMovementType(movementType);
    if (POSITIVE_INVENTORY_MOVEMENT_TYPES.includes(t)) return MAGNITUDE.POSITIVE;
    if (NEGATIVE_INVENTORY_MOVEMENT_TYPES.includes(t)) return MAGNITUDE.NEGATIVE;
    const d = Number(quantityDelta);
    if (Number.isFinite(d) && d > 0) return MAGNITUDE.POSITIVE;
    if (Number.isFinite(d) && d < 0) return MAGNITUDE.NEGATIVE;
    return MAGNITUDE.NEUTRAL;
}

export function assertMovimientosInventario(item) {
    if (!item || typeof item !== "object") {
        throw new Error(
            "SCHEMA_VIOLATION: MovimientosInventario item must be an object"
        );
    }

    const canonicalType = normalizeInventoryMovementType(item.movementType);
    assertValidEnum(canonicalType, INVENTORY_MOVEMENT_TYPE, "movementType");
    item.movementType = canonicalType;

    if (!_nonEmpty(item.movementToken)) {
        throw new Error(
            "SCHEMA_VIOLATION: MovimientosInventario requires movementToken (idempotencia)"
        );
    }
    if (!_nonEmpty(item.traceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: MovimientosInventario requires traceId (SSOT-12)"
        );
    }
    if (!_nonEmpty(item.sku)) {
        throw new Error("SCHEMA_VIOLATION: MovimientosInventario requires sku");
    }

    if (
        canonicalType === INVENTORY_MOVEMENT_TYPE.AJUSTE &&
        !_nonEmpty(item.operationDescription)
    ) {
        throw new Error(
            "SCHEMA_VIOLATION: AJUSTE requires operationDescription"
        );
    }

    const delta = Number(item.quantityDelta);
    if (!Number.isFinite(delta) || delta === 0) {
        throw new Error(
            `SCHEMA_VIOLATION: quantityDelta (${String(item.quantityDelta)}) cannot be 0`
        );
    }

    const qty = Number(item.quantity);
    if (item.quantity !== undefined && item.quantity !== null) {
        if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error(
                `SCHEMA_VIOLATION: quantity (${String(item.quantity)}) must be > 0`
            );
        }
        if (Math.abs(Math.abs(delta) - qty) > 0.001) {
            throw new Error(
                `SCHEMA_VIOLATION: |quantityDelta| (${Math.abs(delta)}) must match quantity (${qty})`
            );
        }
    }

    const before = Number(item.stockBefore);
    const after = Number(item.stockAfter);
    if (
        item.stockBefore !== undefined &&
        item.stockAfter !== undefined &&
        Number.isFinite(before) &&
        Number.isFinite(after)
    ) {
        if (Math.abs(before + delta - after) > 0.001) {
            throw new Error(
                `SCHEMA_VIOLATION: stockAfter (${after}) != stockBefore (${before}) + quantityDelta (${delta})`
            );
        }
    }

    return true;
}

// =============================================================================
// BLOQUE 10 - DOMAIN ENUM ASSERTIONS
// =============================================================================

export function assertMovementType(value) {
    return assertValidEnum(value, MOVEMENT_TYPE, "movementType");
}

export function assertPaymentMethod(value) {
    return assertValidEnum(value, PAYMENT_METHOD, "paymentMethod");
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

export function assertChannelType(value) {
    return assertValidEnum(value, CHANNEL_TYPE, "channelType");
}

export function assertControlType(value) {
    return assertValidEnum(value, CONTROL_TYPE, "controlType");
}

export function assertClockEventType(value) {
    return assertValidEnum(value, CLOCK_EVENT_TYPE, "clockEventType");
}

// =============================================================================
// BLOQUE 11 - WIX ECOM PAYMENT METHOD BOUNDARY (ADR-05)
// OFFLINE/MEMBERSHIP nunca se persisten como metodo real.
// =============================================================================

export const WIX_PAYMENT_METHODS = Object.freeze({
    OFFLINE: "Offline",
    MEMBERSHIP: "Membership",
    CREDIT_CARD: "CreditCard",
    DEBIT_CARD: "DebitCard",
    WALLET: "Wallet",
    BANK_TRANSFER: "BankTransfer",
});

export const REAL_PAYMENT_METHODS = Object.freeze({
    EFECTIVO: PAYMENT_METHOD.EFECTIVO,
    TARJETA: PAYMENT_METHOD.TARJETA,
    BIZUM: PAYMENT_METHOD.BIZUM,
    ONLINE: PAYMENT_METHOD.ONLINE,
    TARJETA_REGALO: PAYMENT_METHOD.TARJETA_REGALO,
});

export function normalizeWixPaymentMethod(wixMethod, medioReal) {
    const w = String(wixMethod ?? "").trim();
    const real = String(medioReal ?? "").trim().toUpperCase();

    if (w === WIX_PAYMENT_METHODS.OFFLINE) {
        if (
            [
                REAL_PAYMENT_METHODS.EFECTIVO,
                REAL_PAYMENT_METHODS.TARJETA,
                REAL_PAYMENT_METHODS.BIZUM,
            ].includes(real)
        ) {
            return real;
        }
        log.warn("OFFLINE wix payment with indeterminable medioReal, defaulting EFECTIVO", {
            wixMethod: w,
            medioReal: real,
        });
        return REAL_PAYMENT_METHODS.EFECTIVO;
    }

    if (w === WIX_PAYMENT_METHODS.MEMBERSHIP) {
        log.warn("MEMBERSHIP wix payment normalized to TARJETA_REGALO per ADR-05", {
            wixMethod: w,
        });
        return REAL_PAYMENT_METHODS.TARJETA_REGALO;
    }

    if (
        w === WIX_PAYMENT_METHODS.CREDIT_CARD ||
        w === WIX_PAYMENT_METHODS.DEBIT_CARD ||
        w === WIX_PAYMENT_METHODS.WALLET
    ) {
        return REAL_PAYMENT_METHODS.TARJETA;
    }

    if (w === WIX_PAYMENT_METHODS.BANK_TRANSFER) {
        return REAL_PAYMENT_METHODS.ONLINE;
    }

    if (real && real !== "OFFLINE" && real !== "MEMBERSHIP") return real;

    log.warn("unknown wix payment method, defaulting EFECTIVO with warn", {
        wixMethod: w,
    });
    return REAL_PAYMENT_METHODS.EFECTIVO;
}
