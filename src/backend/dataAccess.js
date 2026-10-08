/*
=============================================================================
MODULE: backend/dataAccess.js
VERSION: v10.0-SSOT-FRICTIONLESS
BASE: BIBLIA SSOT v9.1 + Anexo D + analisis-sdkv2 (commit b7effa3d)
RESPONSIBILITY: Capa unica de acceso a datos (DAL) del backend de reservas.
  Contrato unico: @wix/data (namespace items) + @wix/essentials (auth.elevate).
STANDARDS: G10 ASCII estricto. Sin console.log directo (logger SSOT).
REEMPLAZA Y ELIMINA: backend/dataClient.js (fachada legacy wix-data).

CORRECCIONES APLICADAS (verificadas contra dev.wix.com, 2026-10):
  C1. items.count NO EXISTE en @wix/data. countItems() se reimplementa sobre
      query() con returnTotalCount: true y limit: 1.
  C2. ARIDAD REAL: get/insert/update/save/remove/query se invocan con TRES
      argumentos posicionales (dataCollectionId, payload, options).
  C3. queryReferencedItems tiene 4 argumentos posicionales reales:
      (dataCollectionId, referringItem, field, options).
  C4. query.filter es OBJETO MongoQL ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/
      $startsWith/$isEmpty/$exists/$hasAll/$hasSome + $and/$or/$not).
      "$contains" NO existe; startsWith solo coincide PREFIJOS.
  C5. Campo real de conteo: pagingMetadata.total (no "totalCount").
  C6. Filtros referencian "_id" a secas (no "dataItemField._id").
  C7. consistentRead (boolean) es la opcion real; no existe enum "consistency".

REGLAS DE MIGRACION (analisis-sdkv2.txt / seguro-migrar.txt):
  R1. suppressAuth NO es opcion valida del SDK v2. El privilegio se construye
      elevando la OPERACION con auth.elevate.
  R2. suppressHooks NO se expone: los hooks de backend/data.js se ejecutan
      SIEMPRE (SSOT-14). Toda escritura debe ser canonica y valida.
  R3. Lectura fuerte se preserva con consistentRead: true.
  R4. Filtros por OBJETO nativo SDK v2. Cero builder legacy, cero WQL string.
  R5. Toda operacion es ELEVADA (identidad de sistema). Colecciones activas
      son Admin-only; webMethods publicos no tienen sesion CMS.
  R6. Normalizacion de frontera: SDK v2 puede devolver 'id'. Este DAL expone
      SIEMPRE '_id' como identificador canonico interno.

ORDEN DE ENTREGA DE LA MIGRACION (9 modulos, dominio reservas online):
  1/9 backend/dataAccess.js            <- ESTE MODULO
  2/9 backend/internalConfig.js
  3/9 backend/validation.js
  4/9 backend/staff.js
  5/9 backend/booking/bookingUtils.js
  6/9 backend/booking/bookingCore.js
  7/9 backend/booking/bookingSaga.js
  8/9 backend/reservas.web.js
  9/9 backend/citasManager.web.js
=============================================================================
*/

import { items } from "@wix/data";
import { auth } from "@wix/essentials";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - OPERACIONES ELEVADAS
// =============================================================================

const elevated = Object.freeze({
    get: auth.elevate(items.get),
    insert: auth.elevate(items.insert),
    update: auth.elevate(items.update),
    save: auth.elevate(items.save),
    remove: auth.elevate(items.remove),
    query: auth.elevate(items.query),
    queryReferencedItems: auth.elevate(items.queryReferencedItems),
});

// =============================================================================
// BLOQUE 2 - CONSTANTES
// =============================================================================

export const CONSISTENCY = Object.freeze({
    STRONG: "STRONG",
    EVENTUAL: "EVENTUAL",
});

const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 50;
const QUERY_ALL_DEFAULT_PAGE_SIZE = 200;
const QUERY_ALL_DEFAULT_MAX_PAGES = 50;

// =============================================================================
// BLOQUE 3 - HELPERS INTERNOS
// =============================================================================

function _requireCollectionId(dataCollectionId) {
    const id =
        typeof dataCollectionId === "string" ? dataCollectionId.trim() : "";
    if (!id) {
        throw new Error("DAL_INVALID_COLLECTION: dataCollectionId es obligatorio");
    }
    return id;
}

function _requireItemId(itemId) {
    const id = typeof itemId === "string" ? itemId.trim() : "";
    if (!id) {
        throw new Error("DAL_INVALID_ITEM_ID: itemId es obligatorio");
    }
    return id;
}

function _requireItemObject(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("DAL_INVALID_ITEM: item debe ser un objeto");
    }
    return item;
}

function _isStrongRead(options) {
    return Boolean(options && options.consistency === CONSISTENCY.STRONG);
}

function _sdkOptionsFor(options) {
    const sdk = {};
    if (_isStrongRead(options)) sdk.consistentRead = true;
    return sdk;
}

function _buildPaging(limit, offset) {
    const safeLimit = Math.min(
        Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE
    );
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return { limit: safeLimit, offset: safeOffset };
}

function _buildQueryRequest(queryFilter, querySort, limit, offset) {
    const queryRequest = { paging: _buildPaging(limit, offset) };
    if (queryFilter && typeof queryFilter === "object") {
        queryRequest.filter = queryFilter;
    }
    if (Array.isArray(querySort) && querySort.length > 0) {
        queryRequest.sort = querySort;
    }
    return queryRequest;
}

/**
 * R6: normalizacion de frontera SDK v2 -> contrato interno.
 * El identificador canonico interno del backend es '_id'.
 */
function _normalizeItem(item) {
    if (!item || typeof item !== "object") return item;
    if (item._id === undefined && item.id !== undefined) {
        return Object.assign({}, item, { _id: item.id });
    }
    return item;
}

function _normalizeItemList(list) {
    return Array.isArray(list) ? list.map(_normalizeItem) : [];
}

function _safeName(dataCollectionId) {
    return typeof dataCollectionId === "string" ? dataCollectionId : "UNKNOWN";
}

// =============================================================================
// BLOQUE 4 - CONSTRUCTORES DE FILTRO Y ORDEN (objeto nativo SDK v2)
// =============================================================================
// Operadores verificados: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin,
// $startsWith, $isEmpty, $exists, $hasAll, $hasSome, $and, $or, $not.
// NO existe "$contains".

export const wql = Object.freeze({
    byId: (value) => ({ _id: { $eq: String(value) } }),
    eq: (field, value) => ({
        [String(field)]: { $eq: value } }),
    ne: (field, value) => ({
        [String(field)]: { $ne: value } }),
    gt: (field, value) => ({
        [String(field)]: { $gt: value } }),
    gte: (field, value) => ({
        [String(field)]: { $gte: value } }),
    lt: (field, value) => ({
        [String(field)]: { $lt: value } }),
    lte: (field, value) => ({
        [String(field)]: { $lte: value } }),
    in: (field, values) => ({
        [String(field)]: { $in: Array.from(values || []) },
    }),
    hasSome: (field, values) => ({
        [String(field)]: { $hasSome: Array.from(values || []) },
    }),
    // LIMITACION: $startsWith solo coincide PREFIJOS, no subcadenas
    // en posicion arbitraria. No existe operador de substring generico.
    startsWith: (field, value) => ({
        [String(field)]: { $startsWith: value },
    }),
    and: (...clauses) => ({
        $and: clauses.filter((clause) => clause && typeof clause === "object"),
    }),
    or: (...clauses) => ({
        $or: clauses.filter((clause) => clause && typeof clause === "object"),
    }),
});

export const order = Object.freeze({
    asc: (fieldName) => [{ fieldName: String(fieldName), order: "ASC" }],
    desc: (fieldName) => [{ fieldName: String(fieldName), order: "DESC" }],
    by: (...specs) =>
        specs
        .map((spec) =>
            spec && typeof spec === "object" && spec.fieldName ?
            {
                fieldName: String(spec.fieldName),
                order: String(spec.order || "ASC").toUpperCase() === "DESC" ?
                    "DESC" :
                    "ASC",
            } :
            null
        )
        .filter(Boolean),
});

// =============================================================================
// BLOQUE 5 - CLASIFICACION DE ERRORES DEL SDK
// =============================================================================

export function isNotFoundError(error) {
    const appError = error?.details?.applicationError || {};
    const code = String(appError.code || error?.code || "").toUpperCase();
    const message = String(error?.message || "").toUpperCase();
    const httpCode = Number(
        appError.httpCode || error?.httpCode || error?.status || 0
    );
    return (
        httpCode === 404 ||
        code === "WDE0111" ||
        code.includes("NOT_FOUND") ||
        message.includes("WDE0111") ||
        message.includes("NOT_FOUND") ||
        message.includes("NOT FOUND")
    );
}

export function isDuplicateKeyError(error) {
    const appError = error?.details?.applicationError || {};
    const code = String(appError.code || error?.code || "").toUpperCase();
    const message = String(error?.message || "").toUpperCase();
    return (
        code === "WDE0123" ||
        code.includes("DUPLICATE") ||
        message.includes("WDE0123") ||
        message.includes("DUPLICATE") ||
        message.includes("ALREADY EXISTS")
    );
}

// =============================================================================
// BLOQUE 6 - CRUD ELEVADO
// =============================================================================

/**
 * Lectura de un item por id.
 * @param {string} dataCollectionId coleccion CMS canonica (SSOT-02)
 * @param {string} itemId
 * @param {{consistency?: string}} [options] CONSISTENCY.STRONG para lecturas
 *        criticas (mutex, secuencias, idempotencia).
 * @returns {Promise<Object>} item con '_id' canonico.
 */
export async function getItem(dataCollectionId, itemId, options = {}) {
    const res = await elevated.get(
        _requireCollectionId(dataCollectionId),
        _requireItemId(itemId),
        _sdkOptionsFor(options)
    );
    return _normalizeItem(res);
}

/**
 * Lectura tolerante: devuelve null si el item no existe; relanza cualquier
 * otro error. Sustituye el patron legacy '.catch(() => null)'.
 */
export async function getItemOrNull(dataCollectionId, itemId, options = {}) {
    try {
        return await getItem(dataCollectionId, itemId, options);
    } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
}

/**
 * Insercion. Los hooks beforeInsert de data.js SE EJECUTAN (R2/SSOT-14).
 */
export async function insertItem(dataCollectionId, item) {
    const res = await elevated.insert(
        _requireCollectionId(dataCollectionId),
        _requireItemObject(item), {}
    );
    return _normalizeItem(res);
}

/**
 * Actualizacion por documento completo (debe incluir _id).
 * Los hooks beforeUpdate de data.js SE EJECUTAN (R2/SSOT-14).
 */
export async function updateItem(dataCollectionId, item) {
    const doc = _requireItemObject(item);
    if (doc._id === undefined && doc.id === undefined) {
        throw new Error("DAL_INVALID_ITEM: update requiere _id");
    }
    const payload =
        doc._id === undefined ? Object.assign({}, doc, { _id: doc.id }) : doc;
    const res = await elevated.update(
        _requireCollectionId(dataCollectionId),
        payload, {}
    );
    return _normalizeItem(res);
}

/**
 * Upsert: inserta si no existe, actualiza si existe (por _id).
 */
export async function saveItem(dataCollectionId, item) {
    const res = await elevated.save(
        _requireCollectionId(dataCollectionId),
        _requireItemObject(item), {}
    );
    return _normalizeItem(res);
}

/**
 * Borrado por id. Los hooks beforeRemove de data.js SE EJECUTAN: los ledgers
 * append-only rechazaran la operacion por normativa (SSOT-05).
 */
export async function removeItem(dataCollectionId, itemId) {
    await elevated.remove(
        _requireCollectionId(dataCollectionId),
        _requireItemId(itemId), {}
    );
}

/**
 * Borrado tolerante: no relanza si el item ya no existe (idempotente).
 */
export async function removeItemIfPresent(dataCollectionId, itemId) {
    try {
        await removeItem(dataCollectionId, itemId);
        return true;
    } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
    }
}

/**
 * Query de una pagina.
 * @param {Object} params
 * @param {string} params.dataCollectionId
 * @param {Object} [params.filter]  filtro por objeto (constructores wql.*)
 * @param {Array}  [params.sort]    orden (constructores order.*)
 * @param {number} [params.limit=50]   maximo 1000
 * @param {number} [params.offset=0]
 * @param {string} [params.consistency] CONSISTENCY.STRONG | CONSISTENCY.EVENTUAL
 * @returns {Promise<{items: Array, totalCount: number|null, pagingMetadata: Object|null}>}
 */
export async function queryItems(params = {}) {
    const {
        dataCollectionId,
        filter: queryFilter,
        sort: querySort,
        limit,
        offset,
        consistency,
    } = params;
    const queryRequest = _buildQueryRequest(queryFilter, querySort, limit, offset);
    const sdkOpts = Object.assign({ returnTotalCount: true },
        consistency === CONSISTENCY.STRONG ? { consistentRead: true } : {}
    );
    const res = await elevated.query(
        _requireCollectionId(dataCollectionId),
        queryRequest,
        sdkOpts
    );
    const meta = res?.pagingMetadata || null;
    const list = _normalizeItemList(res?.items);
    const rawTotal = Number(meta?.total);
    return {
        items: list,
        totalCount: Number.isFinite(rawTotal) ? rawTotal : null,
        pagingMetadata: meta,
    };
}

/**
 * Query que devuelve el primer item o null.
 * Sustituye el patron legacy '.limit(1).find() -> items[0] || null'.
 */
export async function queryFirstItem(params = {}) {
    const res = await queryItems(
        Object.assign({}, params, { limit: 1, offset: 0 })
    );
    return res.items.length > 0 ? res.items[0] : null;
}

/**
 * Paginacion acotada completa (stream accumulator con tope de seguridad).
 * @returns {Promise<Array>} todos los items hasta agotar o alcanzar maxPages.
 */
export async function queryAllPages(params = {}) {
    const {
        dataCollectionId,
        filter: queryFilter,
        sort: querySort,
        pageSize = QUERY_ALL_DEFAULT_PAGE_SIZE,
        maxPages = QUERY_ALL_DEFAULT_MAX_PAGES,
        consistency,
        traceId = null,
    } = params;
    const size = Math.min(
        Math.max(Number(pageSize) || QUERY_ALL_DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE
    );
    const pages = Math.max(Number(maxPages) || QUERY_ALL_DEFAULT_MAX_PAGES, 1);
    const all = [];
    let offset = 0;
    for (let page = 1; page <= pages; page += 1) {
        const res = await queryItems({
            dataCollectionId,
            filter: queryFilter,
            sort: querySort,
            limit: size,
            offset,
            consistency,
        });
        all.push(...res.items);
        if (res.items.length < size) return all;
        offset += size;
    }
    log.warn(
        "DAL_QUERY_ALL_PAGES_TRUNCATED: maxPages alcanzado sin agotar la consulta", { dataCollectionId: _safeName(dataCollectionId), maxPages: pages, traceId }
    );
    return all;
}

/**
 * Conteo con filtro opcional.
 * NOTA (C1): items.count no existe en el SDK; se implementa sobre query()
 * con returnTotalCount: true y limit: 1.
 */
export async function countItems(params = {}) {
    const { dataCollectionId, filter: queryFilter, consistency } = params;
    const res = await queryItems({
        dataCollectionId,
        filter: queryFilter,
        limit: 1,
        offset: 0,
        consistency,
    });
    return res.totalCount != null ? res.totalCount : 0;
}

/**
 * Resolucion de MULTI_REFERENCE (SSOT-16/SSOT-18): items referenciados por un
 * campo de referencia de un item. Unica via de resolucion referencial.
 * Ejemplo: availableStaff (ServiciosCatalogo -> MapaStaff),
 *          addOnOptions (ServiciosCatalogo -> ComplementosCatalogo).
 */
export async function queryReferencedItems(
    dataCollectionId,
    itemId,
    referenceFieldName,
    options = {}
) {
    const field = String(referenceFieldName || "").trim();
    if (!field) {
        throw new Error(
            "DAL_INVALID_REFERENCE_FIELD: referenceFieldName es obligatorio"
        );
    }
    // Firma real: items.queryReferencedItems(dataCollectionId, referringItem,
    // field, options) -- 4 argumentos posicionales (ver C3).
    const res = await elevated.queryReferencedItems(
        _requireCollectionId(dataCollectionId),
        _requireItemId(itemId),
        field,
        _sdkOptionsFor(options)
    );
    // La respuesta trae "results" (items resueltos o unresolvedReference);
    // se filtra a los items efectivamente resueltos.
    const results = Array.isArray(res?.results) ? res.results : [];
    const resolved = results
        .map((r) =>
            r && typeof r === "object" && !r.unresolvedReference ? r : null
        )
        .filter(Boolean);
    return _normalizeItemList(resolved);
}

// =============================================================================
// BLOQUE 7 - GUARD SSOT (SSOT-09 / SSOT-15)
// =============================================================================

/**
 * Guard opcional para consumidores que quieran bloquear explicitamente
 * colecciones prohibidas antes de llamar al DAL.
 * @param {ReadonlyArray<string>} forbiddenList
 * @param {string} dataCollectionId
 */
export function assertNotForbidden(forbiddenList, dataCollectionId) {
    const id = _requireCollectionId(dataCollectionId);
    const forbidden = Array.isArray(forbiddenList) ? forbiddenList : [];
    if (forbidden.includes(id)) {
        throw new Error(
            `DAL_FORBIDDEN_COLLECTION: acceso prohibido a '${id}' (SSOT-09)`
        );
    }
    return id;
}