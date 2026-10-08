/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v11.0-SSOT-CLEAN
BASE: BIBLIA v10.0 §6.3 + §8
RESPONSIBILITY: SSOT de constantes backend.
STANDARDS: G10 ASCII Strict. Cero aliases. Cero legacy.
=============================================================================
*/

// =============================================================================
// BLOQUE 1 - STAFF ACTIVO
// =============================================================================

export const STAFF = Object.freeze({
    IDS: Object.freeze([
        "e556070a-6d6a-402e-8422-11133033ea76",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40",
        "9b905bfd-1a09-485d-9273-a24a20dfe648",
    ]),
    RESOURCE_TO_DISPLAY: Object.freeze({
        "e556070a-6d6a-402e-8422-11133033ea76": "MARIAN MADRID",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "ANDREA STAFF",
        "9b905bfd-1a09-485d-9273-a24a20dfe648": "ALBA STAFF",
    }),
});

// =============================================================================
// BLOQUE 2 - COLECCIONES CMS (BIBLIA §8)
// =============================================================================

export const BUSINESS_COLLECTIONS = Object.freeze({
    DATOS_FISCALES: "DatosFiscales",
    CAJA_ACTUAL: "CajaActual",
    MOVIMIENTOS_CAJA: "MovimientosCaja",
    CITAS_F2: "CitasF2",
    LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
    HISTORICO_CIERRES_Z: "HistoricoCierresZ",
    SERVICIOS_CATALOGO: "ServiciosCatalogo",
    COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
    MAPA_STAFF: "MapaStaff",
    REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
    CONTROL_OPERATIVO: "ControlOperativo",
    INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
});

export const OPERATIONAL_COLLECTIONS = Object.freeze({
    CONTROL_OPERATIVO: "ControlOperativo",
});

// =============================================================================
// BLOQUE 3 - WIX APP IDS
// =============================================================================

export const APP_IDS = Object.freeze({
    BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
    STORES: "215238eb-22a5-4c36-9e7b-e7c08025e04e",
    EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
    FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
    INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
    MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
    GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27",
});

// =============================================================================
// BLOQUE 4 - SDK CONFIG (BIBLIA §8)
// =============================================================================

export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
    LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
    LOCATION_TYPES: Object.freeze({
        TIME_SLOTS: "BUSINESS",
        BOOKINGS_WRITER: "OWNER_BUSINESS",
    }),
    TIMEOUTS: Object.freeze({
        API_MS: 30000,
        BOOKING_CREATION_MS: 50000,
        DUAL_BOOKING_MS: 80000,
        CHECKOUT_MS: 40000,
        CMS_MS: 30000,
        WATCHDOG_MS: 90000,
        WEBHOOK_MS: 60000,
    }),
    CACHE: Object.freeze({
        SERVICES_TTL_MS: 600000,
        SLOTS_CACHE_TTL_MS: 120000,
        DUAL_CACHE_TTL_MS: 900000,
        STAFF_TTL_MS: 300000,
        MAX_ENTRIES: 100,
        DAYS_CACHE_VERSION: 1,
        AVAILABILITY_CACHE_TTL_MS: 600000,
    }),
    SECURITY: Object.freeze({
        SECRET_CACHE_TTL_MS: 300000,
        RATE_LIMIT_CACHE_CLEANUP_TTL_MS: 60000,
        RATE_LIMIT_CACHE_MAX_ENTRIES: 5000,
    }),
    RATE_LIMIT: Object.freeze({
        MAX_REQUESTS: 20,
        WINDOW_MS: 5000,
        BOOKING_MAX_REQUESTS: 5,
        BOOKING_WINDOW_MS: 10000,
        AVAILABILITY_WINDOW_MS: 5000,
        AVAILABILITY_REQUESTER_MAX_REQUESTS: 12,
        AVAILABILITY_GLOBAL_MAX_REQUESTS: 120,
    }),
    JOBS: Object.freeze({
        TIMEOUT_MS: 30000,
        AUDIT_RETENTION_DAYS: 90,
        DELETE_BATCH_SIZE: 100,
        DELETE_MAX_PAGES: 10,
        DUAL_CACHE_CLEANUP_LIMIT: 100,
        FISCAL_RECOVERY_BATCH_SIZE: 25,
        HEALTH_CHECK_QUERY_LIMIT: 1000,
        FISCAL_DAILY_MAX_PAGES: 50,
    }),
    EVENTS: Object.freeze({
        RETRY_ATTEMPTS: 3,
        RETRY_BASE_BACKOFF_MS: 1000,
    }),
    EXTERNAL_HTTP: Object.freeze({
        RATE_LIMIT_MAX_REQUESTS: 20,
        RATE_LIMIT_WINDOW_MS: 5000,
        HMAC_MAX_CLOCK_SKEW_SECONDS: 60,
        CORS_ALLOWED_ORIGINS: Object.freeze([
            "https://www.marianmadrid.es",
            "https://marianmadrid.es",
        ]),
    }),
    M365: Object.freeze({ ENABLED: false }),
    ACCOUNTING: Object.freeze({ ENABLED: false }),
    SYNC_BOOKINGS_SERVICES_ENABLED: false,
    DOCUMENTS: Object.freeze({
        DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
        MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
        MAX_EMAIL_SEND_ATTEMPTS: 3,
    }),
});

// =============================================================================
// BLOQUE 5 - API (BIBLIA §4.1)
// =============================================================================

export const API = Object.freeze({
    STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
});

// =============================================================================
// BLOQUE 6 - SINGLETONS
// =============================================================================

export const SINGLETONS = Object.freeze({
    CAJA_PRINCIPAL: "CAJA_PRINCIPAL",
    CAJA_SEQ: "CAJA_SEQ",
    CONFIG_SISTEMA_FISCAL: "CONFIG_SISTEMA_FISCAL",
});

// =============================================================================
// BLOQUE 7 - CONCURRENCY (BIBLIA §3.2.1 V20)
// =============================================================================

export const CONCURRENCY = Object.freeze({
    MS_TTL_MUTEX: 300000,
    MS_LATIDO: 15000,
    MS_TTL_MUTEX_ASIENTO: 60000,
    TRANSACTION_POLL_BASE_MS: 250,
    TRANSACTION_MAX_WAIT_MS: 3000,
    DEFAULT_DURATION_MIN: 30,
});

// =============================================================================
// BLOQUE 8 - SLOT SEARCH (BIBLIA §3.2.1)
// =============================================================================

export const SLOT_SEARCH = Object.freeze({
    MINUTOS_TOLERANCIA: 120,
    MINUTOS_MAX_HUECO_DUAL: 120,
});

// =============================================================================
// BLOQUE 9 - ENUMS WIX NATIVOS (BIBLIA §6.1 - ingles)
// =============================================================================

export const BOOKING_STATUS = Object.freeze({
    CREATED: "CREATED",
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    DECLINED: "DECLINED",
    WAITING_LIST: "WAITING_LIST",
    UPDATED: "UPDATED",
    CANCELED: "CANCELED",
    REFUNDED: "REFUNDED",
});

export const PAYMENT_STATUS = Object.freeze({
    UNDEFINED: "UNDEFINED",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "PENDING_LEDGER",
    PAID: "PAID",
    PARTIALLY_PAID: "PARTIALLY_PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    EXEMPT: "EXEMPT",
});

// =============================================================================
// BLOQUE 10 - ENUMS CMS (BIBLIA §6.2 - persistidos en CitasF2)
// =============================================================================

export const CITAS_BOOKING_STATUS = Object.freeze({
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    NO_SHOW: "NO_SHOW",
});

export const CITAS_PAYMENT_STATUS = Object.freeze({
    UNPAID: "UNPAID",
    PARTIAL: "PARTIAL",
    PAID: "PAID",
    REFUNDED: "REFUNDED",
});

// =============================================================================
// BLOQUE 11 - ENUMS NEGOCIO (BIBLIA §6.3 - espanol)
// =============================================================================

export const MOVEMENT_TYPE = Object.freeze({
    COBRO: "COBRO",
    DEVOLUCION: "DEVOLUCION",
    APORTACION: "APORTACION",
    RETIRO: "RETIRO",
    PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
    AJUSTE: "AJUSTE",
});

export const CHANNEL_TYPE = Object.freeze({
    PRESENCIAL: "PRESENCIAL",
    ONLINE: "ONLINE",
});

export const PAYMENT_METHOD = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    TRANSFERENCIA: "TRANSFERENCIA",
    WIX_PAYMENTS: "WIX_PAYMENTS",
    OTRO: "OTRO",
});

export const TIPO_IMPOSITIVO_VALIDOS = Object.freeze([0, 0.04, 0.10, 0.21]);

export const CLOCK_EVENT_TYPE = Object.freeze({
    ENTRADA: "ENTRADA",
    SALIDA: "SALIDA",
    PAUSA_INICIO: "PAUSA_INICIO",
    PAUSA_FIN: "PAUSA_FIN",
    AJUSTE: "AJUSTE",
});

export const RECORD_TYPE_HORARIOS = Object.freeze({
    REGULAR: "REGULAR",
    AJUSTE: "AJUSTE",
});

export const INVENTORY_MOVEMENT_TYPE = Object.freeze({
    VENTA: "VENTA",
    DEVOLUCION: "DEVOLUCION",
    AJUSTE: "AJUSTE",
    ENTRADA_STOCK: "ENTRADA_STOCK",
    SALIDA_STOCK: "SALIDA_STOCK",
    TRANSFERENCIA: "TRANSFERENCIA",
});

export const ROL_BOOKINGS = Object.freeze({
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    RECEPTIONIST: "RECEPTIONIST",
    STAFF: "STAFF",
});

export const ROL_WEBSITE = Object.freeze({
    ADMIN: "ADMIN",
    GESTION: "GESTION",
    ESTILISTA: "ESTILISTA",
});

export const CONTROL_TYPE = Object.freeze({
    SLOT_LOCK: "SLOT_LOCK",
    WEBHOOK_EVENT: "WEBHOOK_EVENT",
    DEDUPE_KEY: "DEDUPE_KEY",
    IDEMPOTENCY: "IDEMPOTENCY",
    RATE_LIMIT: "RATE_LIMIT",
    SYSTEM_FLAG: "SYSTEM_FLAG",
});

export const CONTROL_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    COMPLETED: "COMPLETED",
    EXPIRED: "EXPIRED",
});

export const COMPENSATION_KIND = Object.freeze({
    CANCEL_BOOKING: "CANCEL_BOOKING",
    REFUND_PAYMENT: "REFUND_PAYMENT",
});

export const COMPENSATION_STATUS = Object.freeze({
    PENDING: "PENDING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
});

// =============================================================================
// BLOQUE 12 - ENUMS FISCALES
// =============================================================================

export const RECORD_TYPE = Object.freeze({
    TERCERO: "TERCERO",
    CONFIG_SISTEMA: "CONFIG_SISTEMA",
});

export const THIRD_PARTY_TYPE = Object.freeze({
    CLIENTE: "CLIENTE",
    PROVEEDOR: "PROVEEDOR",
    STAFF: "STAFF",
    AAPP: "AAPP",
    MIXTO: "MIXTO",
    EMISOR: "EMISOR",
});

export const FISCAL_ROLE = Object.freeze({
    EMISOR: "EMISOR",
    RECEPTOR: "RECEPTOR",
});

export const CASH_REGISTER_STATUS = Object.freeze({
    ABIERTA: "ABIERTA",
    CERRADA: "CERRADA",
});

// =============================================================================
// BLOQUE 13 - BOOKING TYPE (BIBLIA §6.3 + ADR-17)
// =============================================================================

export const BOOKING_TYPE = Object.freeze({
    SIMPLE: "SIMPLE",
    DUAL_F1: "DUAL_F1",
    DUAL_F2: "DUAL_F2",
});

export const BOOKING_FIELDS = Object.freeze({
    STATUS: "bookingStatus",
});

export const INACTIVE_BOOKING_STATUSES = Object.freeze([
    "CANCELLED",
    "CANCELED",
    "DECLINED",
    "NO_SHOW",
]);

// =============================================================================
// BLOQUE 14 - INTEGRIDAD
// =============================================================================

export const INTEGRITY = Object.freeze({
    LEDGER_SCHEMA_VERSION: "LEDGER_V5_FISCAL",
});

// =============================================================================
// BLOQUE 15 - CATALOG STATES (pendiente ADR - BIBLIA §6.4)
// No se valida en hooks hasta ADR formal.
// =============================================================================

export const CATALOG_STATES = Object.freeze({
    ACTIVO: "ACTIVO",
    DRAFT: "DRAFT",
    PUBLISHED: "PUBLISHED",
    ARCHIVED: "ARCHIVED",
});

// =============================================================================
// BLOQUE 16 - HELPERS DE ENUM
// =============================================================================

export function normalizeBookingType(value) {
    const v = String(value ?? "").trim().toUpperCase();
    if (v === "NORMAL" || v === "SIMPLE") return BOOKING_TYPE.SIMPLE;
    if (v === "DUAL" || v === "DUAL_F1" || v === "DUALF1") return BOOKING_TYPE.DUAL_F1;
    if (v === "DUAL_F2" || v === "DUALF2") return BOOKING_TYPE.DUAL_F2;
    return v;
}

export function isDualBookingType(value) {
    return value === BOOKING_TYPE.DUAL_F1 || value === BOOKING_TYPE.DUAL_F2;
}

export function isValidGuid(value) {
    const v = String(value ?? "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export const MAGNITUDE = Object.freeze({
    POSITIVE: "POSITIVE",
    NEGATIVE: "NEGATIVE",
    NEUTRAL: "NEUTRAL",
});

export const POSITIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    INVENTORY_MOVEMENT_TYPE.DEVOLUCION,
]);

export const NEGATIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.VENTA,
    INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
]);

export const ITEM_NATURE = Object.freeze({
    SERVICIO: "SERVICIO",
    PRODUCTO: "PRODUCTO",
});

export const CODIGO_IMPUESTO = Object.freeze({
    IVA: "IVA",
    EXENTO: "EXENTO",
});
