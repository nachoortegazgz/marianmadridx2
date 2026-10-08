/*
=============================================================================
MODULE: backend/staff.js
VERSION: v8.1-SSOT-MASTER
BASE: BIBLIA v8.0-SSOT-MASTER + ANEXO SSOT v8.1
RESPONSIBILITY: Cache LRU de staff + resolucion de identidad por
                memberId/resourceId/email. DTO publico whitelist.
STANDARDS: G10 ASCII Strict.

CORRECTIONS APPLIED (ANEXO v8.1):
  - C-01: campo 'active' eliminado del cache y del DTO
  - C-02: staffRole → rolBookings + rolWebsite
  - C-03: staffMemberId → memberId
  - SSOT-13: resourceId y memberId inmutables
  - Whitelist DTO publico (sin notes, sin thirdPartyId, sin traceId)
=============================================================================
*/

import wixData from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    SDK_CONFIG,
    ROL_BOOKINGS,
    ROL_WEBSITE,
    MAPA_STAFF_FIELDS,
    STAFF_ACCESS,
} from "backend/internalConfig";

import { assertMapaStaff } from "backend/validation";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES Y CACHE LRU
// =============================================================================

const CACHE_TTL_MS = Number(SDK_CONFIG?.CACHE?.STAFF_TTL_MS) || 300000;
const CACHE_MAX_ENTRIES = Number(SDK_CONFIG?.CACHE?.MAX_ENTRIES) || 100;

const STAFF_CACHE = new Map();

// Whitelist de campos exponibles en DTO publico (RGPD minimizacion)
const PUBLIC_DTO_FIELDS = Object.freeze([
    "resourceId",
    "memberId",
    "displayName",
    "staffName",
    "rolBookings",
    "rolWebsite",
    "scheduleId",
    "locationId",
    "location",
    "email",
    "phone",
]);

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

function _normalizeText(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function _normalizeEmail(value) {
    return _normalizeText(value).toLowerCase();
}

function _isValidGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        _normalizeText(value)
    );
}

function _cacheGet(key) {
    const entry = STAFF_CACHE.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        STAFF_CACHE.delete(key);
        return null;
    }
    // LRU: reinsertar al final
    STAFF_CACHE.delete(key);
    STAFF_CACHE.set(key, entry);
    return entry.value;
}

function _cacheSet(key, value) {
    if (STAFF_CACHE.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = STAFF_CACHE.keys().next().value;
        if (oldestKey) STAFF_CACHE.delete(oldestKey);
    }
    STAFF_CACHE.set(key, { value, timestamp: Date.now() });
}

export function invalidateStaffCache() {
    STAFF_CACHE.clear();
}

// =============================================================================
// BLOQUE 3 - CREACION DE REGISTRO DE STAFF (C-01/C-02/C-03)
// =============================================================================

function _createStaffRecord(item) {
    if (!item || typeof item !== "object") return null;

    return {
        _id: _normalizeText(item._id),
        resourceId: _normalizeText(item.resourceId),
        memberId: _normalizeText(item.memberId), // C-03
        rolBookings: _normalizeText(item.rolBookings).toUpperCase(), // C-02
        rolWebsite: _normalizeText(item.rolWebsite).toUpperCase(), // C-02
        staffName: _normalizeText(item.staffName),
        displayName: _normalizeText(item.displayName),
        thirdPartyId: _normalizeText(item.thirdPartyId),
        email: _normalizeEmail(item.email),
        phone: _normalizeText(item.phone),
        scheduleId: _normalizeText(item.scheduleId),
        locationId: _normalizeText(item.locationId),
        location: _normalizeText(item.location),
        notes: _normalizeText(item.notes),
        traceId: _normalizeText(item.traceId),
        // C-01: campo 'active' NO se copia al registro interno
    };
}

function _buildPublicDTO(record) {
    if (!record) return null;
    const dto = {};
    for (const field of PUBLIC_DTO_FIELDS) {
        if (record[field] !== undefined && record[field] !== "") {
            dto[field] = record[field];
        }
    }
    // C-01: nunca exponer 'active'
    // RGPD: nunca exponer 'notes', 'thirdPartyId', 'traceId'
    return dto;
}

// =============================================================================
// BLOQUE 4 - CARGA COMPLETA DEL CATALOGO
// =============================================================================

async function _loadAllStaff(traceId) {
    const cacheKey = "__ALL__";
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const catalog = _emptyCatalog();
        const result = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .limit(1000)
            .find({ suppressAuth: true });

        for (const item of result?.items || []) {
            const record = _createStaffRecord(item);
            if (!record) continue;
            if (!record._id && !record.resourceId && !record.email) continue;

            catalog.all.push(record);
            _addToIndex(catalog.byResourceId, record.resourceId, record);
            _addToIndex(catalog.byMemberId, record.memberId, record); // C-03
            _addToIndex(catalog.byEmail, record.email, record);
            _addToIndex(catalog.byScheduleId, record.scheduleId, record);
            _addToIndex(catalog.byId, record._id, record);
        }

        _cacheSet(cacheKey, catalog);
        return catalog;
    } catch (error) {
        log.error("Failed to load staff catalog", {
            traceId,
            message: error?.message || String(error),
        });
        return _emptyCatalog();
    }
}

function _emptyCatalog() {
    return {
        all: [],
        byResourceId: new Map(),
        byMemberId: new Map(), // C-03
        byEmail: new Map(),
        byScheduleId: new Map(),
        byId: new Map(),
    };
}

function _addToIndex(index, key, record) {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
}

// =============================================================================
// BLOQUE 5 - RESOLUCION DE STAFF (API PUBLICA)
// =============================================================================

/**
 * Resuelve staff por resourceId, memberId o email.
 * C-03: prioridad memberId > resourceId > email.
 * @param {string} identifier - GUID o email.
 * @param {string} [traceId]
 * @returns {Promise<Object|null>} DTO publico o null.
 */
export async function findStaff(identifier, traceId = null) {
    const id = _normalizeText(identifier);
    if (!id) return null;

    const cacheKey = `find:${id.toLowerCase()}`;
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;

    const catalog = await _loadAllStaff(traceId);
    let record = null;

    if (_isValidGuid(id)) {
        // C-03: intentar por memberId primero
        const byMemberId = catalog.byMemberId.get(id);
        if (byMemberId && byMemberId.length > 0) record = byMemberId[0];

        if (!record) {
            const byResourceId = catalog.byResourceId.get(id);
            if (byResourceId && byResourceId.length > 0) record = byResourceId[0];
        }

        if (!record) {
            const byId = catalog.byId.get(id);
            if (byId && byId.length > 0) record = byId[0];
        }
    }

    if (!record) {
        const byEmail = catalog.byEmail.get(id.toLowerCase());
        if (byEmail && byEmail.length > 0) record = byEmail[0];
    }

    const dto = _buildPublicDTO(record);
    _cacheSet(cacheKey, dto);
    return dto;
}

/**
 * Resuelve staff por resourceId (GUID Bookings).
 * @param {string} resourceId
 * @param {string} [traceId]
 * @returns {Promise<Object|null>}
 */
export async function findStaffByResourceId(resourceId, traceId = null) {
    const id = _normalizeText(resourceId);
    if (!_isValidGuid(id)) return null;

    const cacheKey = `rid:${id}`;
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;

    const catalog = await _loadAllStaff(traceId);
    const matches = catalog.byResourceId.get(id) || [];
    const dto = matches.length > 0 ? _buildPublicDTO(matches[0]) : null;

    _cacheSet(cacheKey, dto);
    return dto;
}

/**
 * Resuelve staff por memberId (GUID Wix Members).
 * C-03: campo canonico.
 * @param {string} memberId
 * @param {string} [traceId]
 * @returns {Promise<Object|null>}
 */
export async function findStaffByMemberId(memberId, traceId = null) {
    const id = _normalizeText(memberId);
    if (!_isValidGuid(id)) return null;

    const cacheKey = `mid:${id}`;
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;

    const catalog = await _loadAllStaff(traceId);
    const matches = catalog.byMemberId.get(id) || [];
    const dto = matches.length > 0 ? _buildPublicDTO(matches[0]) : null;

    _cacheSet(cacheKey, dto);
    return dto;
}

/**
 * Resuelve el scheduleId Bookings asociado a un resourceId canonico.
 * @param {string} resourceId
 * @param {string} [traceId]
 * @returns {Promise<string|null>}
 */
export async function getStaffScheduleId(resourceId, traceId = null) {
    const staff = await findStaffByResourceId(resourceId, traceId);
    return staff ? _normalizeText(staff.scheduleId) || null : null;
}

/**
 * Lista todo el staff (DTO publico).
 * @param {string} [traceId]
 * @returns {Promise<Array<Object>>}
 */
export async function listStaff(traceId = null) {
    const catalog = await _loadAllStaff(traceId);
    return catalog.all.map(_buildPublicDTO).filter(Boolean);
}

/**
 * Lista staff filtrado por rolWebsite.
 * C-02: rol interno de negocio.
 * @param {string} rolWebsite - ADMIN | GESTION | ESTILISTA
 * @param {string} [traceId]
 * @returns {Promise<Array<Object>>}
 */
export async function listStaffByRolWebsite(rolWebsite, traceId = null) {
    const rol = _normalizeText(rolWebsite).toUpperCase();
    if (!Object.values(ROL_WEBSITE).includes(rol)) return [];

    const catalog = await _loadAllStaff(traceId);
    return catalog.all
        .filter((r) => r.rolWebsite === rol)
        .map(_buildPublicDTO)
        .filter(Boolean);
}

/**
 * Lista staff filtrado por rolBookings.
 * C-02: rol oficial Wix Bookings.
 * @param {string} rolBookings - OWNER | ADMIN | RECEPTIONIST | STAFF
 * @param {string} [traceId]
 * @returns {Promise<Array<Object>>}
 */
export async function listStaffByRolBookings(rolBookings, traceId = null) {
    const rol = _normalizeText(rolBookings).toUpperCase();
    if (!Object.values(ROL_BOOKINGS).includes(rol)) return [];

    const catalog = await _loadAllStaff(traceId);
    return catalog.all
        .filter((r) => r.rolBookings === rol)
        .map(_buildPublicDTO)
        .filter(Boolean);
}

/**
 * Lista staff asignable a un servicio (por availableStaff Multi Reference).
 * C-05: resolución mediante queryReferencedItems del SDK Data v2.
 * @param {string} serviceId - GUID ServiciosCatalogo.serviceId
 * @param {string} [traceId]
 * @returns {Promise<Array<Object>>}
 */
export async function listStaffForService(serviceId, traceId = null) {
    const id = _normalizeText(serviceId);
    if (!_isValidGuid(id)) return [];

    const cacheKey = `svc:${id}`;
    const cached = _cacheGet(cacheKey);
    if (cached !== null) return cached;

    try {
        const refs = await wixData.queryReferencedItems(
            BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO,
            id,
            "availableStaff",
            { consistentRead: true }
        );

        const staffIds = (refs?.items || []).map((ref) => ref._id || ref.id);
        const all = await listStaff(traceId);
        const filtered = all.filter((s) =>
            staffIds.includes(s.resourceId) || staffIds.includes(s._id)
        );

        _cacheSet(cacheKey, filtered);
        return filtered;
    } catch (error) {
        log.error("listStaffForService failed", {
            traceId,
            serviceId: id,
            message: error?.message || String(error),
        });
        return [];
    }
}

// =============================================================================
// BLOQUE 6 - VALIDACION DE STAFF (para hooks y webMethods)
// =============================================================================

/**
 * Valida que un item de MapaStaff cumple el schema v8.1.
 * Delega en assertMapaStaff (validation.js).
 * @param {Object} item
 * @returns {boolean}
 */
export function validateStaffRecord(item) {
    try {
        assertMapaStaff(item);
        return true;
    } catch (error) {
        log.warn("Staff record validation failed", {
            message: error?.message || String(error),
        });
        return false;
    }
}

/**
 * Verifica si un resourceId pertenece a Marian (manager).
 * @param {string} resourceId
 * @returns {boolean}
 */
export function isMarianResource(resourceId) {
    return _normalizeText(resourceId) === STAFF_ACCESS.MARIAN_RESOURCE_ID;
}

/**
 * Obtiene el nombre visible de un staff (fallback a STAFF_DEFAULT_NAME).
 * @param {Object} staff - DTO publico.
 * @returns {string}
 */
export function getStaffDisplayName(staff) {
    if (!staff) return "Profesional";
    return (
        _normalizeText(staff.displayName) ||
        _normalizeText(staff.staffName) ||
        "Profesional"
    );
}
