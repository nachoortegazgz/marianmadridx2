/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5011-F1-CANONICAL
BASE NORMATIVA:
  - BIBLIA2 / BIBLIAV v5009-V20-FINAL-CONSOLIDATED-v4.2 (Bloques 1, 3, 4.2.3)
  - CAMBIO.txt secciones 8, 9, 10 (constantes y enums canonicos)
  - INFORME_TECNICO_BOOKINGS_V2 secciones 3.3, 7, 15 (gap, localDate, errores)
  - Dossier CMS vivo 30/09/2026 (ServiciosCatalogo rev.88)
ENTORNO: Wix Editor + Velo | Wix Bookings V2 | Wix Stores Catalog V1
STANDARDS: G10 ASCII estricto. Modulo hoja (leaf): no importa backend.

REGLAS DE MODULO
  1. SSOT de constantes de negocio = backend/internalConfig.js. Este fichero
     solo alberga un ESPEJO de lectura para el frontend (SITE, CURRENCY_CONFIG,
     SLOT_SEARCH, BOOKINGS_ADDON_CONFIG). Cualquier divergencia se resuelve a
     favor de internalConfig y se corrige aqui.
  2. SSOT del protocolo de widget = public/widgetBridge.js. Este modulo solo
     reexporta (facade), nunca redefine.
     RESTRICCION ACICLICA: widgetBridge.js NO debe importar public/mmUtils.js.
  3. Cero alias puros y cero nombres deprecados (D6).
  4. IDs nativas Wix preservadas en ingles camelCase (R19): resourceId,
     serviceId, bookingId, scheduleId, staffMemberId, availabilityConstraints.
  5. Ningun helper de este modulo realiza hashing fiscal. La cadena SHA-256
     del ledger vive exclusivamente en backend/securityEngine.js.
=============================================================================
*/

/* Facade de protocolo: SSOT = public/widgetBridge.js (no redefinir aqui). */
/* FIX(baseline): widgetBridge exporta MESSAGE_TYPES/PROTOCOL_URLS/PROTOCOL_UI
   (los alias sin guion MESSAGETYPES/URLS/UI fueron eliminados del bridge).
   Este facade importaba nombres inexistentes -> SyntaxError en cascada que
   rompia TODO consumidor de mmUtils (logger, security, fiscalAggregator...). */
export {
  MESSAGE_TYPES,
  PROTOCOL_URLS as URLS,
  PROTOCOL_UI as UI
} from "public/widgetBridge";

/* ============================================================================
 * 1. CONSTANTES ESPEJO (frontend-safe) DEL SSOT backend/internalConfig.js
 * ==========================================================================*/

/** Espejo de SITE. No editable aqui sin actualizar internalConfig. */
export const SITE = Object.freeze({
  TIMEZONE: "Europe/Madrid",
  CURRENCY: "EUR",
  DECIMALS: 2,
  LOCALE: "es-ES",
  COUNTRY: "ES"
});

/** Espejo de CURRENCY_CONFIG (CAMBIO.txt 10: MONEY -> CURRENCY_CONFIG). */
export const CURRENCY_CONFIG = Object.freeze({
  MONEDA_VISUALIZACION: SITE.CURRENCY,
  DECIMALES: SITE.DECIMALS
});

/** Espejo de SLOT_SEARCH (BIBLIA 3.2). Nombres de config en espanol (D10). */
export const SLOT_SEARCH = Object.freeze({
  DIAS_LIMITE: 14,
  MINUTOS_TOLERANCIA: 10,
  MINUTOS_MAX_HUECO_DUAL: 120
});

/** Espejo de BOOKINGS_ADDON_CONFIG (BIBLIA 3.2 / 4.3 fila 19). */
export const BOOKINGS_ADDON_CONFIG = Object.freeze({
  MAX_POR_RESERVA: 5
});

/** Tolerancia de cuadre entre duracion declarada y duracion real del slot. */
const SLOT_DURATION_TOLERANCE_MINUTES = 1;

/* ============================================================================
 * 2. PATRONES Y LIMITES
 * ==========================================================================*/

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** R16: dateYmd / dayKey = YYYY-MM-DD en zona Europe/Madrid. */
const DATE_YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Instante local. Segundos opcionales: Wix Bookings V2 devuelve tanto
 * "YYYY-MM-DDTHH:mm" como "YYYY-MM-DDTHH:mm:ss".
 */
const LOCAL_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;

const MAX_TEXT_LENGTH = 5000;
const MAX_ID_LENGTH = 200;
const MAX_GUID_LENGTH = 100;
const MAX_SLUG_LENGTH = 200;
const MAX_TRACE_PREFIX_LENGTH = 40;
const MAX_TRACE_ID_LENGTH = 120;

const DEFAULT_TIMEOUT_MS = 15000;
const MS_PER_MINUTE = 60000;

/* ============================================================================
 * 3. TEXTO
 * ==========================================================================*/

export function _safeTrim(value, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return "";

  const limit = Math.max(1, Number(maxLength) || MAX_TEXT_LENGTH);

  return String(value).trim().slice(0, limit);
}

export function _cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return _safeTrim(value, maxLength).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    ""
  );
}

export function _normalizeIdPart(value, maxLength = MAX_ID_LENGTH) {
  return _cleanText(value, maxLength).replace(/[^a-zA-Z0-9._:-]/g, "_");
}

/**
 * Identidad publica (slug) o identidad tecnica (serviceId).
 * Se eliminan barras internas para impedir path injection en query params.
 */
export function _safeSlugOrId(value) {
  return _safeTrim(value, MAX_SLUG_LENGTH)
    .replace(/\/+/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

/* ============================================================================
 * 4. IDENTIFICADORES (R19: las IDs nativas Wix nunca se transforman)
 * ==========================================================================*/

export function _looksLikeGuid(value) {
  return GUID_PATTERN.test(_safeTrim(value, MAX_GUID_LENGTH));
}

/**
 * Extrae el ID tecnico de una referencia Wix.
 * Formas admitidas: string | {_id} | {id} | {referenceId} | {value} | Array.
 * No inventa referencias: devuelve "" cuando no hay identidad resoluble.
 */
export function getReferenceId(value) {
  if (!value) return "";
  if (typeof value === "string") return _safeTrim(value, MAX_ID_LENGTH);
  if (Array.isArray(value)) {
    return value.length > 0 ? getReferenceId(value[0]) : "";
  }
  if (typeof value === "object") {
    return _safeTrim(
      value._id || value.id || value.referenceId || value.value,
      MAX_ID_LENGTH
    );
  }
  return "";
}

/** MULTI_REFERENCE: lista de IDs tecnicos, unica y sin referencias inventadas. */
export function getReferenceIds(value) {
  if (!value) return [];

  const source = Array.isArray(value) ? value : [value];
  const ids = source
    .map((entry) => getReferenceId(entry))
    .filter(Boolean);

  return Array.from(new Set(ids));
}

/**
 * Lista de GUIDs validos.
 * Formas admitidas: Array<GUID> | CSV | Array<objeto referencia>.
 *
 * AVISO DE IDENTIDAD (INFORME BOOKINGS 15, error 5):
 * ServiciosCatalogo.availableStaff es MULTI_REFERENCE a Members, por lo que
 * esta funcion devuelve staffMemberId, NO resourceId. La resolucion
 * staffMemberId -> resourceId se ejecuta exclusivamente en backend
 * (booking/staffResolver). Nunca enviar el resultado directamente a
 * resourceIds / includeResourceTypeIds de Wix Bookings V2.
 */
export function cleanGuidList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const guids = source
    .map((entry) => _safeTrim(getReferenceId(entry), MAX_GUID_LENGTH))
    .filter(_looksLikeGuid);

  return Array.from(new Set(guids));
}

/**
 * Variante estricta: extrae una clave concreta de objetos referencia y
 * valida que sea GUID. Usar cuando la identidad deba ser inequivoca
 * (resourceId, staffMemberId, serviceId, addOnId nativo).
 */
export function cleanGuidListByKey(value, key) {
  const cleanKey = _safeTrim(key, MAX_ID_LENGTH);
  if (!cleanKey) return [];

  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const guids = source
    .map((entry) => {
      if (typeof entry === "string") return _safeTrim(entry, MAX_GUID_LENGTH);
      if (entry && typeof entry === "object") {
        return _safeTrim(entry[cleanKey], MAX_GUID_LENGTH);
      }
      return "";
    })
    .filter(_looksLikeGuid);

  return Array.from(new Set(guids));
}

export function cleanGuid(value, errorCode = "INVALID_GUID") {
  const clean = _safeTrim(value, MAX_GUID_LENGTH);

  if (!_looksLikeGuid(clean)) {
    const error = new Error(`${errorCode}: Invalid or missing GUID`);
    error.code = errorCode;
    throw error;
  }

  return clean;
}

/** R16: validador de dateYmd / dayKey (YYYY-MM-DD, zona Madrid). */
export function isDateYmd(value) {
  return DATE_YMD_PATTERN.test(_safeTrim(value, 10));
}

/* ============================================================================
 * 5. NUMEROS Y DINERO
 * ==========================================================================*/

/**
 * Numero finito o fallback. No aplica suelo: apto para importes con signo
 * (importeContable, quantityDelta, totalAdjustments).
 */
export function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Numero finito no negativo. ATENCION: convierte negativos en 0.
 * No usar para importes contables con signo ni deltas de inventario.
 */
export function numberOrZero(value, minimum = 0) {
  const parsed = Number(value);
  const floor = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;

  return Number.isFinite(parsed) && parsed >= floor ? parsed : 0;
}

/** Redondeo monetario con los decimales canonicos de CURRENCY_CONFIG. */
export function _roundMoney(value, decimals = CURRENCY_CONFIG.DECIMALES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;

  const factor = 10 ** Math.max(0, toFiniteNumber(decimals, CURRENCY_CONFIG.DECIMALES));

  return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

export function _readPositiveAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function booleanValue(...values) {
  return values.some((value) => value === true);
}

/** Booleano estricto con fallback. Rechaza textos "true"/"false" ambiguos. */
export function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (clean === "true") return true;
    if (clean === "false") return false;
  }
  return fallback;
}

/* ============================================================================
 * 6. FECHAS — ZONA UNICA Europe/Madrid
 * ==========================================================================*/

function formatMadridParts(date, options) {
  const dt = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(dt.getTime())) return null;

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: SITE.TIMEZONE,
    hourCycle: "h23",
    ...options
  })
    .formatToParts(dt)
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
}

/**
 * Normaliza a ISO local. Acepta "YYYY-MM-DDTHH:mm[:ss[.SSS]][Z|+hh:mm]".
 * Devuelve "" si el valor no es un instante reconocible.
 */
export function _normalizeLocalIsoStr(value) {
  const raw = _safeTrim(value, 80);
  if (!raw) return "";

  const normalized = raw.replace(/\s+/, "T");
  if (!LOCAL_ISO_PATTERN.test(normalized)) return "";

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";

  return normalized;
}

function hasExplicitOffset(value) {
  const raw = _safeTrim(value, 80);
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
}

/**
 * Interpreta una cadena local SIN desplazamiento como hora civil de Madrid y
 * devuelve el instante UTC real. Si la cadena ya trae Z u offset, se respeta.
 * Corrige el desfase por zona del navegador (INFORME BOOKINGS 15, error 3).
 */
export function getUtcDateFromMadridLocal(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const raw = _normalizeLocalIsoStr(value);
  if (!raw) return null;

  if (hasExplicitOffset(raw)) {
    const explicit = new Date(raw);
    return Number.isNaN(explicit.getTime()) ? null : explicit;
  }

  const naive = new Date(`${raw.length === 16 ? `${raw}:00` : raw}Z`);
  if (Number.isNaN(naive.getTime())) return null;

  // naive = hora civil de Madrid leida como si fuera UTC. Se corrige con el
  // desplazamiento real de Madrid en ese instante (CET/CEST).
  const offsetMinutes = madridOffsetMinutes(naive);

  return new Date(naive.getTime() - offsetMinutes * MS_PER_MINUTE);
}

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const raw = _normalizeLocalIsoStr(value);
  if (!raw) return null;

  return getUtcDateFromMadridLocal(raw);
}

export function _toDateSafe(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  return parseDate(value);
}

/** dateYmd / dayKey (YYYY-MM-DD) en zona Madrid. R16. */
export function _readDate(value) {
  const clean = _safeTrim(value, 40);

  if (DATE_YMD_PATTERN.test(clean)) return clean;

  const date = _toDateSafe(value);
  if (!date) return null;

  return getMadridDateYmd(date);
}

export function getMadridLocalStringNoZ(value) {
  const parts = formatMadridParts(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  if (!parts) return "";

  return [
    `${parts.year}-${parts.month}-${parts.day}`,
    `${parts.hour}:${parts.minute}:${parts.second}`
  ].join("T");
}

export function getMadridDateYmd(date = new Date()) {
  const parts = formatMadridParts(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  if (!parts) return "";

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getMadridTime(date = new Date()) {
  const parts = formatMadridParts(date, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  if (!parts) return "";

  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

/** monthKey (YYYY-MM) en zona Madrid. RegistrosHorariosStaff.monthKey. */
export function getMadridMonthKey(date = new Date()) {
  const parts = formatMadridParts(date, {
    year: "numeric",
    month: "2-digit"
  });

  if (!parts) return "";

  return `${parts.year}-${parts.month}`;
}

export function toMadridIsoLocal(date = new Date()) {
  return getMadridLocalStringNoZ(date);
}

/** ISO 8601 UTC con sufijo Z: contrato createBooking (BIBLIA 2.2.1). */
export function toUtcIsoZ(value) {
  const date = value instanceof Date ? value : _toDateSafe(value);
  if (!date) return "";

  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function madridOffsetMinutes(date = new Date()) {
  const source = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(source.getTime())) return 0;

  const madridDate = new Date(
    source.toLocaleString("en-US", { timeZone: SITE.TIMEZONE })
  );
  const utcDate = new Date(
    source.toLocaleString("en-US", { timeZone: "UTC" })
  );

  return Math.round((madridDate.getTime() - utcDate.getTime()) / MS_PER_MINUTE);
}

export function formatUtcOffset(offsetMinutes) {
  const offset = toFiniteNumber(offsetMinutes, 0);
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);

  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");

  return `${sign}${hours}:${minutes}`;
}

/**
 * fromLocalDate / toLocalDate de fecha-hora local COMPLETA.
 * listAvailabilityTimeSlots rechaza rangos con solo YYYY-MM-DD
 * (INFORME BOOKINGS 7 y 15, error 2).
 */
export function buildLocalDateRange(dateYmd) {
  const clean = _safeTrim(dateYmd, 10);
  if (!DATE_YMD_PATTERN.test(clean)) return null;

  return Object.freeze({
    dateYmd: clean,
    fromLocalDate: `${clean}T00:00:00`,
    toLocalDate: `${clean}T23:59:59`,
    timeZone: SITE.TIMEZONE
  });
}

/**
 * Rango UTC valido para un slot local. Devuelve null si el intervalo no es
 * parseable o si end <= start.
 */
export function toUtcRange(startLocal, endLocal) {
  const startUtc = getUtcDateFromMadridLocal(startLocal);
  const endUtc = getUtcDateFromMadridLocal(endLocal);

  if (!startUtc || !endUtc || endUtc <= startUtc) return null;

  return Object.freeze({ startUtc, endUtc });
}

/**
 * GAP entre fases en minutos (BIBLIA 4.3 filas 15-17).
 * Devuelve null cuando los instantes no son validos: un gap ilegible nunca
 * debe degradarse a 0, porque 0 es un gap valido y ocultaria el error.
 */
export function computeGapMinutes(firstEndUtc, secondStartUtc) {
  if (!(firstEndUtc instanceof Date) || !(secondStartUtc instanceof Date)) {
    return null;
  }
  if (Number.isNaN(firstEndUtc.getTime()) || Number.isNaN(secondStartUtc.getTime())) {
    return null;
  }

  const gap = Math.round(
    (secondStartUtc.getTime() - firstEndUtc.getTime()) / MS_PER_MINUTE
  );

  return Number.isFinite(gap) ? gap : null;
}

/** Regla dual: gap >= 0 y gap <= MINUTOS_MAX_HUECO_DUAL (120 min). */
export function isDualGapWithinLimit(gapMinutes) {
  if (!Number.isFinite(Number(gapMinutes))) return false;

  const gap = Number(gapMinutes);

  return gap >= 0 && gap <= SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL;
}

/* ============================================================================
 * 7. DURACIONES Y SLOTS (ServiciosCatalogo rev.88)
 * ==========================================================================*/

/**
 * durationRange: clave tecnica canonica CMS (OBJECT).
 * availabilityConstraints: estructura nativa Wix Bookings (R19, preservada).
 */
export function readDurationRange(item = {}) {
  const constraints =
    item.availabilityConstraints ||
    item.data?.availabilityConstraints ||
    item.fields?.availabilityConstraints;

  const range =
    constraints?.durationRange ||
    item.durationRange ||
    item.data?.durationRange ||
    item.fields?.durationRange;

  if (!range || typeof range !== "object") return null;

  const min = numberOrZero(range.minDuration ?? range.min);
  const rawMax = numberOrZero(range.maxDuration ?? range.max);
  const max = rawMax > 0 ? rawMax : Infinity;

  if (min <= 0 && max === Infinity) return null;
  if (max !== Infinity && max <= min) return null;

  return Object.freeze({ min, max });
}

/**
 * Aritmetica dual SSOT: totalDuration = phase1Duration + exposureDuration
 * + phase2Duration. En servicio dual (allowCombine) el slot reservable
 * corresponde a la fase 1.
 */
export function resolveExpectedSlotMinutes(serviceConfig = {}) {
  if (serviceConfig.allowCombine === true) {
    return numberOrZero(serviceConfig.phase1Duration);
  }

  return numberOrZero(
    serviceConfig.phase1Duration ||
    serviceConfig.totalDuration ||
    serviceConfig.metadata?.timing?.estimatedTotal
  );
}

/** Suma exacta de fases. Devuelve null si el servicio no declara fases. */
export function computeTotalDuration(serviceConfig = {}) {
  const phase1 = numberOrZero(serviceConfig.phase1Duration);
  const exposure = numberOrZero(serviceConfig.exposureDuration);
  const phase2 = numberOrZero(serviceConfig.phase2Duration);

  const sum = phase1 + exposure + phase2;

  return sum > 0 ? sum : null;
}

export function validateSlotDuration({
  serviceConfig = {},
  startLocal,
  endLocal
} = {}) {
  const base = Object.freeze({
    ok: true,
    code: null,
    actualMinutes: 0,
    expectedMinutes: null,
    min: null,
    max: null
  });

  const range = toUtcRange(startLocal, endLocal);
  if (!range) {
    return { ...base, ok: false, code: "INVALID_SLOT_RANGE" };
  }

  const actualMinutes = Math.round(
    (range.endUtc.getTime() - range.startUtc.getTime()) / MS_PER_MINUTE
  );

  const result = { ...base, actualMinutes };

  const limits = readDurationRange(serviceConfig);

  if (limits) {
    result.min = limits.min;
    result.max = limits.max === Infinity ? null : limits.max;

    const belowMin = actualMinutes < limits.min;
    const aboveMax = limits.max !== Infinity && actualMinutes > limits.max;

    if (belowMin || aboveMax) {
      return { ...result, ok: false, code: "SLOT_DURATION_OUT_OF_RANGE" };
    }

    return result;
  }

  const expected = resolveExpectedSlotMinutes(serviceConfig);

  if (expected > 0) {
    result.expectedMinutes = expected;

    if (Math.abs(actualMinutes - expected) > SLOT_DURATION_TOLERANCE_MINUTES) {
      return { ...result, ok: false, code: "SLOT_DURATION_MISMATCH" };
    }
  }

  return result;
}

/* ============================================================================
 * 8. OBJETOS
 * ==========================================================================*/

export function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

export function _cloneDeep(value) {
  if (value === null || typeof value !== "object") return value;

  if (value instanceof Date) return new Date(value.getTime());

  if (Array.isArray(value)) return value.map(_cloneDeep);

  return Object.entries(value).reduce((result, [key, child]) => {
    result[key] = _cloneDeep(child);
    return result;
  }, {});
}

/**
 * Serializacion estable para huellas y claves de cache.
 * AVISO: no es hashing fiscal. La cadena SHA-256 del ledger
 * (recordHash / previousRecordHash) se genera en backend/securityEngine.js.
 */
export function _stableSerialize(value) {
  if (value === null || value === undefined) return String(value);

  if (Array.isArray(value)) {
    return `[${value.map(_stableSerialize).join(",")}]`;
  }

  if (value instanceof Date) return `"${value.toISOString()}"`;

  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/* ============================================================================
 * 9. TRAZABILIDAD (R18: traceId obligatorio en escrituras operativas)
 * ==========================================================================*/

export function _generateUUID() {
  const globalCrypto = typeof crypto !== "undefined" ? crypto : undefined;

  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    try {
      return globalCrypto.randomUUID();
    } catch (error) {
      // Se degrada al generador determinista de abajo.
    }
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0;
    const value = character === "x" ? random : (random & 0x3) | 0x8;

    return value.toString(16);
  });
}

/**
 * traceId auditable: prefijo normalizado + instante + UUID v4.
 * Longitud maxima 120 (schema CitasF2.traceId / RegistrosHorariosStaff.traceId).
 * No es identidad principal del registro (BIBLIAV 19).
 */
export function makeTraceId(prefix = "trace") {
  const safePrefix = _normalizeIdPart(prefix, MAX_TRACE_PREFIX_LENGTH) || "trace";
  const traceId = `${safePrefix}-${Date.now().toString(36)}-${_generateUUID()}`;

  return traceId.slice(0, MAX_TRACE_ID_LENGTH);
}

/**
 * Hash corto NO criptografico para claves de cache, slotKey y dedupe.
 * Prohibido para integridad fiscal, firmas o HMAC.
 */
export function _hashKey(value) {
  const stringValue = String(value ?? "");

  let hash1 = 0xdeadbeef ^ stringValue.length;
  let hash2 = 0x41c6ce57 ^ stringValue.length;

  for (let index = 0; index < stringValue.length; index += 1) {
    const character = stringValue.charCodeAt(index);

    hash1 = Math.imul(hash1 ^ character, 2654435761);
    hash2 = Math.imul(hash2 ^ character, 1597334677);
  }

  hash1 =
    Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^
    Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);

  hash2 =
    Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^
    Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);

  return (
    (hash2 >>> 0).toString(16).padStart(8, "0") +
    (hash1 >>> 0).toString(16).padStart(8, "0")
  );
}

/* ============================================================================
 * 10. ENMASCARADO DE PII (logs sin datos personales)
 * ==========================================================================*/

export function _maskEmail(value) {
  const email = _safeTrim(value, 254);
  const at = email.indexOf("@");

  if (at <= 1) return "[REDACTED_EMAIL]";

  return `${email[0]}***${email.slice(at - 1)}`;
}

export function _maskPhone(value) {
  const phone = _safeTrim(value, 40);

  return phone.length > 4 ? `***${phone.slice(-4)}` : "[REDACTED_PHONE]";
}

export function _maskName(value) {
  const name = _safeTrim(value, 120);

  return name ? `${name[0]}***` : "[REDACTED_NAME]";
}

/** NIF/CIF: se conservan los 2 ultimos caracteres para conciliacion visual. */
export function _maskTaxId(value) {
  const taxId = _safeTrim(value, 20);

  return taxId.length > 2 ? `***${taxId.slice(-2)}` : "[REDACTED_TAX_ID]";
}

/* ============================================================================
 * 11. ASINCRONIA
 * ==========================================================================*/

/**
 * Timeout de watchdog. No cancela el trabajo subyacente: solo libera al
 * llamador. El timeout canonico del backend es SDK_CONFIG.TIMEOUTS.WATCHDOG_MS.
 */
export function withTimeout(promiseOrFactory, timeoutMs, label = "OPERATION_TIMEOUT") {
  const factory =
    typeof promiseOrFactory === "function" ? promiseOrFactory : () => promiseOrFactory;

  const timeout = Math.max(1, toFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS));

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;

      const error = new Error(label);
      error.code = "TIMEOUT";

      reject(error);
    }, timeout);

    Promise.resolve()
      .then(factory)
      .then((value) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Reintento con backoff exponencial.
 * isRetryable permite excluir errores deterministas (validacion, permisos,
 * integridad fiscal) que nunca se resuelven reintentando.
 */
export async function _executeWithRetry(fn, maxRetries = 2, delayMs = 300, isRetryable = null) {
  const retries = Math.max(0, toFiniteNumber(maxRetries, 0));
  const baseDelay = Math.max(0, toFiniteNumber(delayMs, 0));

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const retryable = typeof isRetryable === "function" ? isRetryable(error) : true;
      if (!retryable || attempt >= retries) break;

      const wait = baseDelay * 2 ** attempt;
      await new Promise((resolve) => {
        setTimeout(resolve, wait);
      });
    }
  }

  throw lastError;
}
