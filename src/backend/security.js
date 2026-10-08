/*
=============================================================================
MODULE: backend/security.js
VERSION: v8.1-SSOT-MASTER
BASE: BIBLIA v8.0-SSOT-MASTER + ANEXO SSOT v8.1
RESPONSIBILITY: Motor de seguridad. Rate limiter con ventana deslizante,
                verificacion de roles (rolWebsite) y bloqueo persistente
                cross-instancia via ControlOperativo.
STANDARDS: G10 ASCII Strict.

CORRECTIONS APPLIED (ANEXO v8.1):
  - BUG-01 FIX: eliminado .eq("active", true) (C-01: campo no existe)
  - BUG-01 FIX: staff?.rol → staff?.rolWebsite (C-02)
  - C-02: COLLABORATOR_ROLES → ROL_WEBSITE
  - C-03: staffMemberId → memberId en resolucion de identidad
  - SSOT-11: rolWebsite es capa de autorizacion interna sobre permisos Velo
=============================================================================
*/

import wixData from "backend/dataAccess";
import { members } from "@wix/members";

import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONTROL_STATUS,
    SDK_CONFIG,
    ROL_WEBSITE,
    STAFF_ACCESS,
    MAPA_STAFF_FIELDS,
} from "backend/internalConfig";

import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const RATE_LIMIT_CACHE = new Map();

const RATE_LIMIT_MAX_REQUESTS =
    Number(SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS) || 20;

const RATE_LIMIT_WINDOW_MS =
    Number(SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS) || 5000;

const RATE_LIMIT_CLEANUP_TTL_MS =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS) || 60000;

const RATE_LIMIT_CACHE_MAX_ENTRIES =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES) || 5000;

const PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER = 3;
const PERSISTENT_BLOCK_DURATION_MS = 60 * 60 * 1000;

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let lastCleanupTime = Date.now();

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

function _safeString(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function _isValidGuid(value) {
    return GUID_PATTERN.test(_safeString(value));
}

function _normalizeRateLimitPart(value, fallback = "unknown") {
    const normalized = _safeString(value);
    if (!normalized) return fallback;
    return normalized.slice(0, 200);
}

function _buildRateLimitCacheKey(surface, key) {
    return `${_normalizeRateLimitPart(surface)}:${_normalizeRateLimitPart(key)}`;
}

function _buildPersistentBlockId(surface, key) {
    const raw = `${_normalizeRateLimitPart(surface)}_${_normalizeRateLimitPart(key)}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return `RL_${raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 190)}`;
}

function _cleanupRateLimitCache() {
    const now = Date.now();
    if (now - lastCleanupTime < RATE_LIMIT_CLEANUP_TTL_MS) return;

    lastCleanupTime = now;

    for (const [cacheKey, entry] of RATE_LIMIT_CACHE.entries()) {
        const windowStart = now - entry.windowMs;
        entry.timestamps = (entry.timestamps || []).filter(
            (timestamp) => timestamp > windowStart
        );
        const activeBlock =
            Number(entry.blockedUntil) > now && entry.blockedUntil !== null;
        if (entry.timestamps.length === 0 && !activeBlock) {
            RATE_LIMIT_CACHE.delete(cacheKey);
        }
    }

    if (RATE_LIMIT_CACHE.size <= RATE_LIMIT_CACHE_MAX_ENTRIES) return;

    const entriesToDelete =
        RATE_LIMIT_CACHE.size - RATE_LIMIT_CACHE_MAX_ENTRIES;
    let deleted = 0;
    for (const cacheKey of RATE_LIMIT_CACHE.keys()) {
        if (deleted >= entriesToDelete) break;
        RATE_LIMIT_CACHE.delete(cacheKey);
        deleted += 1;
    }
}

function _createAccessDeniedError(requiredRole) {
    const error = new Error(`ACCESS_DENIED: ${requiredRole} role required`);
    error.code = "ACCESS_DENIED";
    error.requiredRole = requiredRole;
    return error;
}

// =============================================================================
// BLOQUE 3 - RESOLUCION DE STAFF (BUG-01 FIX: sin .eq("active"), usa memberId)
// =============================================================================

async function _queryStaffByEmail(email, traceId) {
    const normalizedEmail = _safeString(email).toLowerCase();
    if (!normalizedEmail) return null;

    try {
        // C-01: eliminado .eq("active", true). El ciclo de vida se gestiona
        // por ausencia de registro o por rolWebsite.
        const result = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq(MAPA_STAFF_FIELDS.EMAIL, normalizedEmail)
            .limit(1)
            .find({ suppressAuth: true });

        return result?.items?.[0] || null;
    } catch (error) {
        log.error("Staff lookup by email failed", {
            traceId,
            message: error?.message || String(error),
        });
        return null;
    }
}

async function _queryStaffByMemberId(memberId, traceId) {
    const normalizedMemberId = _safeString(memberId);
    if (!normalizedMemberId || !_isValidGuid(normalizedMemberId)) return null;

    try {
        // C-03: resolucion por memberId (antes staffMemberId)
        const result = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq(MAPA_STAFF_FIELDS.MEMBER_ID, normalizedMemberId)
            .limit(1)
            .find({ suppressAuth: true });

        return result?.items?.[0] || null;
    } catch (error) {
        log.error("Staff lookup by memberId failed", {
            traceId,
            message: error?.message || String(error),
        });
        return null;
    }
}

// =============================================================================
// BLOQUE 4 - RATE LIMITER LOCAL
// =============================================================================

export function rateLimiter(
    { surface, key } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    _cleanupRateLimitCache();

    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    const max = Math.max(1, Number(maxRequests) || RATE_LIMIT_MAX_REQUESTS);
    const window = Math.max(1, Number(windowMs) || RATE_LIMIT_WINDOW_MS);

    const cacheKey = _buildRateLimitCacheKey(normalizedSurface, normalizedKey);
    const now = Date.now();

    let entry = RATE_LIMIT_CACHE.get(cacheKey);
    if (!entry) {
        entry = {
            timestamps: [],
            blockedUntil: null,
            persistentBlockTriggered: false,
            maxRequests: max,
            windowMs: window,
        };
        RATE_LIMIT_CACHE.set(cacheKey, entry);
    }

    entry.maxRequests = max;
    entry.windowMs = window;

    if (entry.blockedUntil && entry.blockedUntil > now) {
        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
            persistentBlock: true,
        };
    }

    if (entry.blockedUntil && entry.blockedUntil <= now) {
        entry.blockedUntil = null;
        entry.persistentBlockTriggered = false;
    }

    const windowStart = now - window;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const persistentThreshold = max * PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER;

    if (entry.timestamps.length >= persistentThreshold) {
        if (!entry.persistentBlockTriggered) {
            entry.persistentBlockTriggered = true;
            entry.blockedUntil = now + PERSISTENT_BLOCK_DURATION_MS;

            const traceId = makeTraceId("rl-block");
            registerPersistentBlock(
                normalizedSurface,
                normalizedKey,
                PERSISTENT_BLOCK_DURATION_MS,
                traceId
            ).catch((error) => {
                log.error("Persistent block registration failed", {
                    traceId,
                    message: error?.message || String(error),
                });
            });

            log.warn("Persistent rate limit block triggered", {
                surface: normalizedSurface,
                key: normalizedKey,
                requestsInWindow: entry.timestamps.length,
                threshold: persistentThreshold,
                durationMs: PERSISTENT_BLOCK_DURATION_MS,
                traceId,
            });
        }

        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
            persistentBlock: true,
        };
    }

    if (entry.timestamps.length >= max) {
        const oldestTimestamp = entry.timestamps[0] || now;
        const retryAfterMs = oldestTimestamp + window - now;
        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            persistentBlock: false,
        };
    }

    entry.timestamps.push(now);

    return { allowed: true, retryAfter: 0, persistentBlock: false };
}

// =============================================================================
// BLOQUE 5 - BLOQUEO PERSISTENTE (ControlOperativo RATE_LIMIT)
// =============================================================================

export async function isKeyPersistentlyBlocked(surface, key) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    if (!normalizedSurface || !normalizedKey) return false;

    try {
        const result = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", `${normalizedSurface}|${normalizedKey}`)
            .gt("expiresAt", new Date())
            .limit(1)
            .find({ suppressAuth: true });

        return Array.isArray(result?.items) && result.items.length > 0;
    } catch (error) {
        log.error("Persistent block lookup failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
        });
        return false;
    }
}

export async function registerPersistentBlock(surface, key, durationMs, traceId = null) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);
    const safeDurationMs = Math.max(
        1000,
        Number(durationMs) || PERSISTENT_BLOCK_DURATION_MS
    );

    if (!normalizedSurface || !normalizedKey) {
        return { status: "ERROR", registered: false, reason: "INVALID_BLOCK_KEY" };
    }

    const expiresAt = new Date(Date.now() + safeDurationMs);
    const blockId = _buildPersistentBlockId(normalizedSurface, normalizedKey);

    try {
        const existing = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", `${normalizedSurface}|${normalizedKey}`)
            .gt("expiresAt", new Date())
            .limit(1)
            .find({ suppressAuth: true });

        if (existing?.items?.length > 0) {
            return { status: "SUCCESS", registered: false, alreadyBlocked: true };
        }

        await wixData.insert(
            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
            {
                controlType: CONTROL_TYPE.RATE_LIMIT,
                dedupeKey: `${normalizedSurface}|${normalizedKey}`,
                status: CONTROL_STATUS.BLOCKED,
                _id: blockId,
                traceId: traceId || `rate-${blockId}`,
                surface: normalizedSurface,
                requesterKey: normalizedKey,
                expiresAt,
            },
            { suppressAuth: true }
        );

        log.warn("Persistent block registered", {
            surface: normalizedSurface,
            key: normalizedKey,
            durationMs: safeDurationMs,
            traceId,
        });

        return { status: "SUCCESS", registered: true, alreadyBlocked: false };
    } catch (error) {
        log.error("Persistent block registration failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
            traceId,
        });
        return {
            status: "ERROR",
            registered: false,
            reason: "PERSISTENT_BLOCK_REGISTRATION_FAILED",
        };
    }
}

// =============================================================================
// BLOQUE 6 - IDENTIDAD DEL MIEMBRO
// =============================================================================

async function _getCurrentMemberInfo(traceId = null) {
    try {
        const member = await members.getCurrentMember();
        if (!member) return null;

        const memberId = _safeString(member._id);
        const email = _safeString(
            member.loginEmail || member.contactDetails?.email
        ).toLowerCase();

        return { memberId, email };
    } catch (error) {
        log.error("Current member lookup failed", {
            traceId,
            message: error?.message || String(error),
        });
        return null;
    }
}

// =============================================================================
// BLOQUE 7 - VERIFICACION DE ROLES (BUG-01 FIX: usa rolWebsite)
// =============================================================================

async function _resolveStaffForCurrentMember(traceId) {
    const memberInfo = await _getCurrentMemberInfo(traceId);
    if (!memberInfo) return null;

    // C-03: prioridad a memberId (mas robusto que email)
    if (memberInfo.memberId) {
        const byMemberId = await _queryStaffByMemberId(memberInfo.memberId, traceId);
        if (byMemberId) return byMemberId;
    }

    if (memberInfo.email) {
        const byEmail = await _queryStaffByEmail(memberInfo.email, traceId);
        if (byEmail) return byEmail;
    }

    return null;
}

export async function isAdmin(traceId = null) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    // C-02: rolWebsite (no staff?.rol que nunca existio)
    return staff?.rolWebsite === ROL_WEBSITE.ADMIN;
}

export async function isCajero(traceId = null) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    return (
        staff?.rolWebsite === ROL_WEBSITE.ADMIN ||
        staff?.rolWebsite === ROL_WEBSITE.GESTION
    );
}

export async function isStaffCollaborator(traceId = null) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    return STAFF_ACCESS.ALLOWED_ROLES.includes(staff?.rolWebsite);
}

export async function isEstilista(traceId = null) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    return staff?.rolWebsite === ROL_WEBSITE.ESTILISTA;
}

export async function getMyStaffContext(traceId = null) {
    const staff = await _resolveStaffForCurrentMember(traceId);
    if (!staff) return null;

    return {
        resourceId: staff.resourceId,
        memberId: staff.memberId, // C-03
        rolBookings: staff.rolBookings, // C-02
        rolWebsite: staff.rolWebsite, // C-02
        displayName: staff.displayName || staff.staffName,
        email: staff.email,
        scheduleId: staff.scheduleId,
        locationId: staff.locationId,
    };
}

// =============================================================================
// BLOQUE 8 - EXIGENCIA DE ROLES
// =============================================================================

export async function requireAdmin(traceId = null) {
    const authorized = await isAdmin(traceId);
    if (!authorized) throw _createAccessDeniedError("ADMIN");
    return true;
}

export async function requireCajero(traceId = null) {
    const authorized = await isCajero(traceId);
    if (!authorized) throw _createAccessDeniedError("CAJERO");
    return true;
}

export async function requireStaffCollaborator(traceId = null) {
    const authorized = await isStaffCollaborator(traceId);
    if (!authorized) throw _createAccessDeniedError("STAFF_COLLABORATOR");
    return true;
}

export async function requireMarianManager(traceId = null) {
    const authorized = await isAdmin(traceId);
    if (!authorized) throw _createAccessDeniedError("MARIAN_MANAGER");
    return true;
}
