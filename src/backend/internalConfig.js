/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v8.1-SSOT-MASTER
BASE: v5010-CLEAN + BIBLIA v8.0-SSOT-MASTER + ANEXO SSOT v8.1
RESPONSIBILITY: Single Source of Truth (SSOT) for backend configuration.
STANDARDS: G10 ASCII Strict. Zero Deprecated Aliases. Zero Legacy.

CORRECTIONS APPLIED (ANEXO v8.1):
  - C-01: Campo 'active' eliminado globalmente (ciclo de vida via 'status')
  - C-02: staffRole → rolBookings + rolWebsite (enums separados)
  - C-03: staffMemberId → memberId (GUID Wix Members)
  - C-05: ServiciosCatalogo.locationId → Multi Reference Locations/Locations
  - C-06: ServiciosCatalogo.mainMedia → Image nativo Wix
  - ADR-17: Enums SNAKE_CASE con guiones bajos (DUAL_F1, NOT_PAID, SLOT_LOCK)
  - BUG-02 FIX: JWT.EXPIRATION_MS (antes MS_EXPIRACION inconsistente)
  - SSOT-01: Alias COLLECTIONS erradicado
=============================================================================
*/

// =============================================================================
// BLOQUE 1 - STAFF ACTIVO (HARDCODED SEGURO)
// =============================================================================

export const STAFF = Object.freeze({
    IDS: Object.freeze([
        "e556070a-6d6a-402e-8422-11133033ea76", // Marian
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40", // Andrea
        "9b905bfd-1a09-485d-9273-a24a20dfe648", // Alba
    ]),
    RESOURCE_TO_DISPLAY: Object.freeze({
        "e556070a-6d6a-402e-8422-11133033ea76": "MARIAN MADRID",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "ANDREA STAFF",
        "9b905bfd-1a09-485d-9273-a24a20dfe648": "ALBA STAFF",
    }),
});

// =============================================================================
// BLOQUE 2 - COLECCIONES CMS CANONICAS (SSOT-01, SSOT-02)
// Alias COLLECTIONS ERRADICADO. Consumidores usan grupos explicitos.
// =============================================================================

export const BUSINESS_COLLECTIONS = Object.freeze({
    CAJA_ACTUAL: "CajaActual",
    CITAS_F2: "CitasF2",
    DATOS_FISCALES: "DatosFiscales",
    HISTORICO_CIERRES_Z: "HistoricoCierresZ",
    INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
    LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
    CONTROL_OPERATIVO: "ControlOperativo",
    MOVIMIENTOS_CAJA: "MovimientosCaja",
    MAPA_STAFF: "MapaStaff",
    REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
    SERVICIOS_CATALOGO: "ServiciosCatalogo",
    COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
});

export const OPERATIONAL_COLLECTIONS = Object.freeze({
    CONTROL_OPERATIVO: "ControlOperativo",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
});

export const RESERVED_COLLECTIONS = Object.freeze({
    COMPRAS_PROVEEDORES: "ComprasProveedores",
    LINEAS_COMPRA_PROVEEDOR: "LineasCompraProveedor",
    PRODUCTOS_CATALOGO: "ProductosCatalogo",
    PRODUCTOS_VARIANTES: "ProductosVariantes",
    UBICACIONES_INVENTARIO: "UbicacionesInventario",
    PROVEEDORES_LISTA: "ProveedoresLista",
});

export const HISTORICAL_COLLECTIONS = Object.freeze({
    BOOKINGS_SERVICE_SYNC_QUEUE: "BookingsServiceSyncQueue",
    M365_GRAPH_SYNC_QUEUE: "M365GraphSyncQueue",
});

export const RETIRED_COLLECTIONS = Object.freeze([
    "SecuenciaTickets",
    "InventarioStockVentaCierre",
]);

export const FORBIDDEN_COLLECTIONS = Object.freeze([
    "AsientosContables",
    "EventosSistemaFacturacion",
    "FacturasRecibidas",
    "ConfiguracionFiscal",
    "LibroRegistroFacturasRecibidas",
    "PlanCuentasContables",
    "CategoriasServicio",
    "LibroRegistroFacturasExpedidas",
]);

export const WIX_APP_COLLECTIONS = Object.freeze({
    BOOKINGS_SERVICES: "Bookings/Services",
    BOOKINGS_SCHEDULE: "Bookings/Schedule",
    BOOKINGS_STAFF: "Bookings/Staff",
    LOCATIONS: "Locations/Locations",
    STORES_PRODUCTS: "Stores/Products",
    STORES_VARIANTS: "Stores/Variants",
    STORES_ORDERS: "Stores/Orders",
    STORES_INVENTORY: "Stores/InventoryItems",
    MEMBERS_FULL_DATA: "Members/FullData",
    MEMBERS_PRIVATE: "Members/PrivateMembersData",
    MEMBERS_PUBLIC: "Members/PublicData",
});

// =============================================================================
// BLOQUE 3 - WIX APP IDS & API KEYS
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

export const API = Object.freeze({
    STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
    MARIAN_MANAGEMENT_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 4 - SINGLETONS & SDK CONFIG
// =============================================================================

export const SINGLETONS = Object.freeze({
    CAJA_PRINCIPAL: "CAJA_PRINCIPAL",
    CAJA_SEQ: "CAJA_SEQ",
    CONFIG_SISTEMA_FISCAL: "CONFIG_SISTEMA_FISCAL",
});

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
// BLOQUE 5 - CONCURRENCIA Y TRANSACCIONES
// =============================================================================

export const CONCURRENCY = Object.freeze({
    MS_TTL_MUTEX: 300000,
    MS_LATIDO: 15000,
    TRANSACTION_POLL_BASE_MS: 250,
    TRANSACTION_MAX_WAIT_MS: 3000,
    LOCK_CLEANUP_GRACE_MS: 60000,
    MAX_COMPENSATION_RETRIES: 3,
    LEDGER_MUTEX_TTL_MS: 45000,
    LOCK_RELEASE_MIN_REMAINING_MS: 15000,
    DEFAULT_DURATION_MIN: 30,
});

// =============================================================================
// BLOQUE 6 - JWT (BUG-02 FIX: nombre canonico EXPIRATION_MS)
// =============================================================================

export const JWT = Object.freeze({
    ALGORITHM: "HS256",
    EXPIRATION_MS: 1800000,
});

// =============================================================================
// BLOQUE 7 - ENUMS WIX CANONICOS (BIBLIA 9.2, SNAKE_CASE ADR-17)
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

export const INACTIVE_BOOKING_STATUSES = Object.freeze([
    BOOKING_STATUS.CANCELED,
    BOOKING_STATUS.DECLINED,
    "REJECTED",
    "NOSHOW",
]);

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

// BIBLIA 11.2 / ADR-17: SNAKE_CASE canonico (DUAL_F1, DUAL_F2)
export const BOOKING_TYPE = Object.freeze({
    SIMPLE: "SIMPLE",
    DUAL_F1: "DUAL_F1",
    DUAL_F2: "DUAL_F2",
});

// =============================================================================
// BLOQUE 8 - ENUMS DE NEGOCIO (BIBLIA 9.3, SNAKE_CASE ADR-17)
// =============================================================================

export const PAYMENT_METHOD = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    ONLINE: "ONLINE",
    TARJETA_REGALO: "TARJETA_REGALO",
});

export const MOVEMENT_TYPE = Object.freeze({
    VENTA_EFECTIVO: "VENTA_EFECTIVO",
    VENTA_TARJETA: "VENTA_TARJETA",
    VENTA_BIZUM: "VENTA_BIZUM",
    VENTA_ONLINE: "VENTA_ONLINE",
    VENTA_PRODUCTO: "VENTA_PRODUCTO",
    VENTA_PRODUCTO_ONLINE: "VENTA_PRODUCTO_ONLINE",
    VENTA_TARJETA_REGALO: "VENTA_TARJETA_REGALO",
    CANJE_TARJETA_REGALO: "CANJE_TARJETA_REGALO",
    REEMBOLSO: "REEMBOLSO",
    DEVOLUCION_SERVICIO: "DEVOLUCION_SERVICIO",
    DEVOLUCION_PRODUCTO: "DEVOLUCION_PRODUCTO",
    AJUSTE: "AJUSTE",
    PROPINA: "PROPINA",
    APORTE: "APORTE",
    RETIRO: "RETIRO",
    GASTO: "GASTO",
    PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
    ANTICIPO: "ANTICIPO",
    FONDO_INICIAL: "FONDO_INICIAL",
});

// BIBLIA 9.3: MOVEMENT_TYPE_INVENTARIO canonico (6 valores)
export const INVENTORY_MOVEMENT_TYPE = Object.freeze({
    VENTA: "VENTA",
    DEVOLUCION: "DEVOLUCION",
    AJUSTE: "AJUSTE",
    ENTRADA_STOCK: "ENTRADA_STOCK",
    SALIDA_STOCK: "SALIDA_STOCK",
    TRANSFERENCIA: "TRANSFERENCIA",
});

export const MAGNITUDE = Object.freeze({
    POSITIVE: 1,
    NEGATIVE: -1,
    NEUTRAL: 0,
});

export const NEGATIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.VENTA,
    INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
]);

export const POSITIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.DEVOLUCION,
    INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
]);

export const CHANNEL_TYPE = Object.freeze({
    PRESENCIAL: "PRESENCIAL",
    ONLINE: "ONLINE",
});

export const CASH_REGISTER_STATUS = Object.freeze({
    ABIERTA: "ABIERTA",
    CERRADA: "CERRADA",
});

export const ITEM_NATURE = Object.freeze({
    SERVICIO_PROPIO: "SERVICIO_PROPIO",
    PRODUCTO_VENTA: "PRODUCTO_VENTA",
    PRODUCTO_USO: "PRODUCTO_USO",
    GASTO_FIJO: "GASTO_FIJO",
});

export const CATALOG_STATES = Object.freeze({
    ACTIVO: "ACTIVO",
    INACTIVO: "INACTIVO",
    BORRADOR: "BORRADOR",
});

// =============================================================================
// BLOQUE 9 - ROLES (ANEXO v8.1 C-02: separacion Bookings vs Website)
// COLLABORATOR_ROLES y STAFF_ROLE ELIMINADOS → sustituidos por ROL_WEBSITE
// =============================================================================

// Rol oficial Wix Bookings (permisos dentro de la app nativa)
export const ROL_BOOKINGS = Object.freeze({
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    RECEPTIONIST: "RECEPTIONIST",
    STAFF: "STAFF",
});

// Rol interno de negocio del sitio web (autorizacion interna SSOT-11)
export const ROL_WEBSITE = Object.freeze({
    ADMIN: "ADMIN",
    GESTION: "GESTION",
    ESTILISTA: "ESTILISTA",
});

export const STAFF_ACCESS = Object.freeze({
    ALLOWED_ROLES: Object.freeze([
        ROL_WEBSITE.ADMIN,
        ROL_WEBSITE.GESTION,
        ROL_WEBSITE.ESTILISTA,
    ]),
    MARIAN_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 10 - ENUMS FISCALES AEAT
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

export const TIPO_FACTURA = Object.freeze({
    F1: "F1",
    F2: "F2",
    R1: "R1",
    R2: "R2",
    R3: "R3",
    R4: "R4",
    R5: "R5",
});

export const CORRECTION_REASON = Object.freeze({
    NUMERO_SERIE: "NUMERO_SERIE",
    OTRAS: "OTRAS",
});

export const VAT_ACCRUAL_STATUS = Object.freeze({
    DEVENGADO: "DEVENGADO",
    ANTICIPADO: "ANTICIPADO",
    APLICACION_ANTICIPO: "APLICACION_ANTICIPO",
});

export const TIPO_RECTIFICATIVA = Object.freeze({
    I: "I",
    S: "S",
});

export const FISCAL_ROLE = Object.freeze({
    EMISOR: "EMISOR",
    RECEPTOR: "RECEPTOR",
});

export const EVENT_TYPE = Object.freeze({
    VENTA_LINEA: "VENTA_LINEA",
    COMPRA_LINEA: "COMPRA_LINEA",
    CIERRE_Z: "CIERRE_Z",
    AJUSTE: "AJUSTE",
    RECTIFICATIVA: "RECTIFICATIVA",
    MOV_STOCK: "MOV_STOCK",
});

export const ESTADO_ENVIO_AEAT = Object.freeze({
    PENDIENTE: "PENDIENTE",
    ENVIADO: "ENVIADO",
    ACEPTADO: "ACEPTADO",
    RECHAZADO: "RECHAZADO",
});

export const CODIGO_IMPUESTO = Object.freeze({
    IVA_21: "IVA_21",
    IVA_10: "IVA_10",
    IVA_4: "IVA_4",
    IVA_0: "IVA_0",
    IRPF_15: "IRPF_15",
    IRPF_19: "IRPF_19",
    EXENTO: "EXENTO",
});

export const TIPO_IMPOSITIVO = Object.freeze({
    GENERAL: 0.21,
    REDUCIDO: 0.10,
    SUPERREDUCIDO: 0.04,
    EXENTO: 0,
});

export const TIPO_IMPOSITIVO_VALIDOS = Object.freeze([0, 0.04, 0.10, 0.21]);

export const IVA_RATES = Object.freeze({
    GENERAL: 0.21,
    REDUCIDO: 0.10,
    SUPERREDUCIDO: 0.04,
    EXENTO: 0,
});

export const EU_VAT_PREFIXES = Object.freeze([
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
    "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);

export const CLAVE_REGIMEN_AEAT = Object.freeze([
    "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
    "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
]);

// =============================================================================
// BLOQUE 11 - ENUMS OPERATIVOS (ControlOperativo, Horarios, Cierres)
// =============================================================================

export const CONTROL_TYPE = Object.freeze({
    SLOT_LOCK: "SLOT_LOCK",
    WEBHOOK_EVENT: "WEBHOOK_EVENT",
    RATE_LIMIT: "RATE_LIMIT",
    BOOKING_TX: "BOOKING_TX",
    COMPENSATION: "COMPENSATION",
    ALERT: "ALERT",
    DAYS_CACHE: "DAYS_CACHE",
    DUAL_CACHE: "DUAL_CACHE",
});

export const CONTROL_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    PENDING: "PENDING",
    EXECUTED: "EXECUTED",
    FAILED: "FAILED",
    EXPIRED: "EXPIRED",
    BLOCKED: "BLOCKED",
    CLOSED: "CLOSED",
    CANCELLED: "CANCELLED",
});

export const COMPENSATION_KIND = Object.freeze({
    STOCK: "STOCK",
    PAGO: "PAGO",
    CITA: "CITA",
    INVENTARIO: "INVENTARIO",
    FINANCIERA: "FINANCIERA",
    CANCEL_BOOKING: "CANCEL_BOOKING",
});

export const COMPENSATION_STATUS = Object.freeze({
    PENDIENTE: "PENDIENTE",
    EJECUTADO: "EJECUTADO",
    FALLIDO: "FALLIDO",
    CANCELADO: "CANCELADO",
    REVERTIDO: "REVERTIDO",
});

export const SEVERITY = Object.freeze({
    INFO: "INFO",
    WARNING: "WARNING",
    ERROR: "ERROR",
    CRITICAL: "CRITICAL",
});

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

export const CLOCK_REGISTERED_BY = Object.freeze({
    SELF: "AUTOMATICO",
    MANAGER: "GESTOR",
    SYSTEM: "SISTEMA",
});

export const RECORD_DOMAIN = Object.freeze({
    CIERRE_Z: "CIERRE_Z",
    CIERRE_INVENTARIO: "CIERRE_INVENTARIO",
    PAQUETE_GESTORIA: "PAQUETE_GESTORIA",
});

export const CLOSING_TYPE = Object.freeze({
    DIARIO: "DIARIO",
    MENSUAL: "MENSUAL",
    ANUAL: "ANUAL",
    EXTRAORDINARIO: "EXTRAORDINARIO",
    PAQUETE_GESTORIA: "PAQUETE_GESTORIA",
});

export const CLOSING_STATUS = Object.freeze({
    ABIERTO: "ABIERTO",
    CERRADO: "CERRADO",
    VERIFICADO: "VERIFICADO",
});

export const PACKAGE_STATUS = Object.freeze({
    PREPARED: "PREPARED",
    SENT: "SENT",
});

export const ORIGEN_TIPO = Object.freeze({
    MOVIMIENTO_CAJA: "MOVIMIENTO_CAJA",
    ASIENTO_CONTABLE: "ASIENTO_CONTABLE",
    EVENTO_SISTEMA_FACTURACION: "EVENTO_SISTEMA_FACTURACION",
    CIERRE_Z: "CIERRE_Z",
    RECTIFICATIVA: "RECTIFICATIVA",
});

// =============================================================================
// BLOQUE 12 - ENUMS COMPLEMENTARIOS
// =============================================================================

export const PRICING_MODEL = Object.freeze({
    FIJO: "FIJO",
    POR_MINUTO: "POR_MINUTO",
    POR_PERSONA: "POR_PERSONA",
});

export const DEPOSIT_TYPE = Object.freeze({
    FIJO: "FIJO",
    PORCENTAJE: "PORCENTAJE",
});

export const DIRECTION = Object.freeze({
    ENTRADA: "ENTRADA",
    SALIDA: "SALIDA",
});

export const PROJECTION_STATUS = Object.freeze({
    PENDIENTE: "PENDIENTE",
    OK: "OK",
    ERROR: "ERROR",
});

// =============================================================================
// BLOQUE 13 - FIELD KEYS CANONICOS (ANEXO v8.1 C-03)
// =============================================================================

export const BOOKING_FIELDS = Object.freeze({
    BOOKING_ID: "bookingId",
    STATUS: "bookingStatus",
    PAYMENT_STATUS: "paymentStatus",
    BOOKING_TYPE: "bookingType",
    PAIR_TOKEN: "pairToken",
    SERVICE_ID: "serviceId",
    RESOURCE_ID: "resourceId",
    STAFF_RESOURCE_ID: "staffResourceId",
    SCHEDULE_ID: "scheduleId",
    DATE_YMD: "dateYmd",
    START_DATE: "startDate",
    END_DATE: "endDate",
    THIRD_PARTY_ID: "thirdPartyId",
    CATALOG_ID: "catalogId",
    CASH_MOVEMENT_ID: "cashMovementId",
    FISCAL_DATA: "fiscalData",
    INVOICING_DATE: "invoicingDate",
    SOURCE_EVENT_ID: "sourceEventId",
    CONTACT_DETAILS: "contactDetails",
    REVISION: "revision",
    TRACE_ID: "traceId",
});

// ANEXO v8.1 C-02/C-03: memberId (no staffMemberId), rolBookings + rolWebsite
export const MAPA_STAFF_FIELDS = Object.freeze({
    RESOURCE_ID: "resourceId",
    MEMBER_ID: "memberId",
    ROL_BOOKINGS: "rolBookings",
    ROL_WEBSITE: "rolWebsite",
    STAFF_NAME: "staffName",
    EMAIL: "email",
    THIRD_PARTY_ID: "thirdPartyId",
    DISPLAY_NAME: "displayName",
    SCHEDULE_ID: "scheduleId",
    LOCATION_ID: "locationId",
    LOCATION: "location",
    PHONE: "phone",
    NOTES: "notes",
    TRACE_ID: "traceId",
});

export const REGISTROS_HORARIOS_FIELDS = Object.freeze({
    RESOURCE_ID: "resourceId",
    MEMBER_ID: "memberId", // ANEXO v8.1 C-04
    RECORDED_AT: "recordedAt",
    RECORDED_TIME: "recordedTime",
    CLOCK_EVENT_TYPE: "clockEventType",
    RECORD_TYPE: "recordType",
    ADJUSTMENT_REASON: "adjustmentReason",
    SIGNATURE: "signature",
    DAY_KEY: "dayKey",
    MONTH_KEY: "monthKey",
    STAFF_NAME: "staffName",
    REGISTERED_BY: "registeredBy",
    REGISTERED_BY_MEMBER_ID: "registeredByMemberId",
    DEVICE_IP_ADDRESS: "deviceIpAddress",
    META: "meta",
    TRACE_ID: "traceId",
});

// =============================================================================
// BLOQUE 14 - CUENTAS PGC Y CONFIGURACION FISCAL
// =============================================================================

export const ACCOUNTING_ACCOUNT = Object.freeze({
    CASH: "570000",
    BANKS: "572000",
    SERVICE_REVENUE: "705000",
    VAT_OUTPUT: "477000",
    VAT_INPUT: "472000",
    SALES_RETURNS: "708000",
    SUPPLIERS: "400000",
    PURCHASES_EXPENSES: "600000",
    SUSPENSE: "555000",
    TAX_IRPF_WITHHOLDING_PAYABLE: "475100",
    TAX_IRPF_WITHHOLDING_RECEIVABLE: "473000",
    TAX_EQUIVALENCE_SURCHARGE: "475800",
    CUSTOMER_ADVANCES: "438000",
    INVENTORY: "300000",
    CLIENTS: "430000",
});

export const ACCOUNTING_ACCOUNT_NAME = Object.freeze({
    "570000": "Caja EUR",
    "572000": "Bancos",
    "705000": "Prestacion de Servicios",
    "477000": "HP IVA Repercutido",
    "472000": "HP IVA Soportado",
    "708000": "Devoluciones de Ventas",
    "400000": "Proveedores",
    "600000": "Compra de Mercaderias",
    "555000": "Cuenta Puente",
    "475100": "HP Retenciones a Practicar",
    "473000": "HP Retenciones Sufridas",
    "475800": "HP Recargo de Equivalencia",
    "438000": "Anticipos de Clientes",
    "300000": "Existencias de Mercaderias",
    "430000": "Clientes",
});

export const COMPUTER_SYSTEM = Object.freeze({
    computerSystemName: "Marian Madrid Velo",
    computerSystemId: "MM-VELO-001",
    version: "v8.1",
    installationNumber: "1",
    possibleUseOnlyVerifactu: "S",
    possibleUseMultiOT: "N",
    multipleOTIndicator: "N",
    producerTaxId: null,
    producerLegalName: null,
});

export const INTEGRITY = Object.freeze({
    SCHEMA_VERSION: "v8.1",
    ALGORITHM_VERSION: "SHA256-v1",
    LEDGER_SCHEMA_VERSION: "LEDGER_V5_FISCAL",
    ENTRY_SCHEMA_VERSION: "ENTRY_V1",
    GENESIS_HASH: "GENESIS_HASH_MM_2024",
    INTEGRITY_ALGORITHM_VERSION: "HMAC_SHA256_V1",
});

export const FISCAL_LIMITS = Object.freeze({
    CASHPAYMENT_MAX_EUR: 1000,
    MONEY_EPSILON: 0.02,
    ACCOUNTING_EPSILON: 0.005,
    MAX_AMOUNT_PER_INVOICE: 100000,
    MAX_AMOUNT_PER_DAY: 500000,
    MAX_INVOICES_PER_DAY: 1000,
    MAX_ITEMS_PER_INVOICE: 100,
    MAX_QUANTITY_PER_ITEM: 99999,
    MIN_DATE: "2020-01-01",
    MAX_DATE: "2030-12-31",
});

export const IRPF_WITHHOLDING_RATE = Object.freeze({
    PROFESIONALES_GENERAL: 0.15,
    PROFESIONALES_PRIMEROS_3_ANOS: 0.07,
    MODULOS: 0.01,
    NINGUNA: 0,
});

// =============================================================================
// BLOQUE 15 - CONFIGURACION DE CATALOGO Y SLOTS
// =============================================================================

export const CATALOG_CONFIG = Object.freeze({
    STATES: CATALOG_STATES,
    CURRENCY: "EUR",
    MAX_TITLE_LENGTH: 160,
    MAX_SUMMARY_LENGTH: 120,
    MAX_DESCRIPTION_LENGTH: 6000,
    MAX_DURATION_MINUTES: 1440,
});

export const SLOT_SEARCH = Object.freeze({
    DIAS_LIMITE: 14,
    MINUTOS_TOLERANCIA: 10,
    MINUTOS_MAX_HUECO_DUAL: 120,
});

export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_POR_RESERVA: 5,
    ACTIVE_NATIVE_IDS: Object.freeze([]),
});

export const CURRENCY_CONFIG = Object.freeze({
    DISPLAY_CURRENCY: "EUR",
    DECIMALS: 2,
});

export const STAFF_DEFAULT_NAME = "Profesional";

// =============================================================================
// BLOQUE 16 - VALIDATION SETS (CFG-13)
// =============================================================================

export const VALIDATION_SETS = Object.freeze({
    MOVEMENT_TYPES: new Set(Object.values(MOVEMENT_TYPE)),
    PAYMENT_METHODS: new Set(Object.values(PAYMENT_METHOD)),
    THIRD_PARTY_TYPES: new Set(Object.values(THIRD_PARTY_TYPE)),
    BOOKING_STATUSES: new Set(Object.values(BOOKING_STATUS)),
    PAYMENT_STATUSES: new Set(Object.values(PAYMENT_STATUS)),
    BOOKING_TYPES: new Set(Object.values(BOOKING_TYPE)),
    CONTROL_TYPES: new Set(Object.values(CONTROL_TYPE)),
    CONTROL_STATUSES: new Set(Object.values(CONTROL_STATUS)),
    CLOCK_EVENT_TYPES: new Set(Object.values(CLOCK_EVENT_TYPE)),
    INVENTORY_MOVEMENT_TYPES: new Set(Object.values(INVENTORY_MOVEMENT_TYPE)),
    ITEM_NATURES: new Set(Object.values(ITEM_NATURE)),
    CATALOG_STATES_SET: new Set(Object.values(CATALOG_STATES)),
    ROL_BOOKINGS_SET: new Set(Object.values(ROL_BOOKINGS)),
    ROL_WEBSITE_SET: new Set(Object.values(ROL_WEBSITE)),
    CODIGOS_IMPUESTO: new Set(Object.values(CODIGO_IMPUESTO)),
    TIPOS_IMPOSITIVOS: new Set(TIPO_IMPOSITIVO_VALIDOS),
    EVENT_TYPES_REQUIRING_CATALOG: new Set([
        EVENT_TYPE.VENTA_LINEA,
        EVENT_TYPE.COMPRA_LINEA,
        EVENT_TYPE.RECTIFICATIVA,
        EVENT_TYPE.MOV_STOCK,
    ]),
});

export const NEGATIVE_SIGN_MOVEMENT_TYPES = Object.freeze([
    MOVEMENT_TYPE.REEMBOLSO,
    MOVEMENT_TYPE.DEVOLUCION_SERVICIO,
    MOVEMENT_TYPE.DEVOLUCION_PRODUCTO,
    MOVEMENT_TYPE.GASTO,
    MOVEMENT_TYPE.PAGO_PROVEEDOR,
    MOVEMENT_TYPE.RETIRO,
]);

// =============================================================================
// BLOQUE 17 - HELPERS CRITICOS
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidGuid(guid) {
    if (typeof guid !== "string") return false;
    return GUID_PATTERN.test(guid.trim());
}

export function enumEq(value, expectedEnumValue) {
    if (!value || !expectedEnumValue) return false;
    return String(value).trim().toUpperCase() ===
        String(expectedEnumValue).trim().toUpperCase();
}

export function enumIn(value, enumObject) {
    if (!value || !enumObject) return false;
    const stringValue = String(value).trim().toUpperCase();
    return Object.values(enumObject).some(
        (v) => String(v).trim().toUpperCase() === stringValue
    );
}

// READ-ONLY migration normalizer (EOL 31/12/2026).
// ADR-17: SNAKE_CASE canonico. Legacy DUALF1/DUALF2/DUAL/DUAL_F1 aceptados en lectura.
export function normalizeBookingType(type) {
    if (!type) return BOOKING_TYPE.SIMPLE;
    const normalized = String(type).trim().toUpperCase();
    if (normalized === "SIMPLE" || normalized === "NORMAL") {
        return BOOKING_TYPE.SIMPLE;
    }
    if (
        normalized === "DUAL_F1" ||
        normalized === "DUALF1" ||
        normalized === "DUAL_F_1"
    ) {
        return BOOKING_TYPE.DUAL_F1;
    }
    if (
        normalized === "DUAL_F2" ||
        normalized === "DUALF2" ||
        normalized === "DUAL_F_2"
    ) {
        return BOOKING_TYPE.DUAL_F2;
    }
    if (normalized === "DUAL") return BOOKING_TYPE.DUAL_F1;
    return BOOKING_TYPE.SIMPLE;
}

export function isDualBookingType(type) {
    const t = normalizeBookingType(type);
    return t === BOOKING_TYPE.DUAL_F1 || t === BOOKING_TYPE.DUAL_F2;
}

export function buildInvoiceNumber(year, month, sequenceNumber) {
    const y = String(year).slice(-2);
    const m = String(month).padStart(2, "0");
    const seq = String(sequenceNumber).padStart(4, "0");
    return `${y}${m}-${seq}`;
}

export function buildComputerSystem(fiscalConfig) {
    const fallback = { ...COMPUTER_SYSTEM };

    if (!fiscalConfig || typeof fiscalConfig !== "object") {
        return Object.freeze(fallback);
    }

    if (!fiscalConfig.nifProductor && !fiscalConfig.producerTaxId) {
        throw new Error(
            "FISCAL_VIOLATION: nifProductor es obligatorio en DatosFiscales CONFIG_SISTEMA para operar en modo Veri*Factu"
        );
    }

    return Object.freeze({
        computerSystemName: fiscalConfig.sistemaInformatico?.computerSystemName ||
            fallback.computerSystemName,
        computerSystemId: fiscalConfig.idSistemaInformatico || fallback.computerSystemId,
        version: fiscalConfig.version || fallback.version,
        installationNumber: fiscalConfig.numeroInstalacion || fallback.installationNumber,
        possibleUseOnlyVerifactu: fiscalConfig.tipoUsoPosibleSoloVerifactu ||
            fallback.possibleUseOnlyVerifactu,
        possibleUseMultiOT: fiscalConfig.tipoUsoPosibleMultiOT || fallback.possibleUseMultiOT,
        multipleOTIndicator: fiscalConfig.indicadorMultiplesOT || fallback.multipleOTIndicator,
        producerTaxId: fiscalConfig.nifProductor || fiscalConfig.producerTaxId,
        producerLegalName: fiscalConfig.nombreRazonProductor || fallback.producerLegalName,
    });
}

export function resolveWithholdingAccount(fiscalRole) {
    switch (fiscalRole) {
    case FISCAL_ROLE.EMISOR:
        return ACCOUNTING_ACCOUNT.TAX_IRPF_WITHHOLDING_PAYABLE;
    case FISCAL_ROLE.RECEPTOR:
        return ACCOUNTING_ACCOUNT.TAX_IRPF_WITHHOLDING_RECEIVABLE;
    default:
        return null;
    }
}

// =============================================================================
// BLOQUE 18 - VALIDACION DE INTEGRIDAD SSOT
// =============================================================================

export function validateInternalConfig() {
    const issues = [];

    if (!BUSINESS_COLLECTIONS.CITAS_F2 || !OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO) {
        issues.push("Colecciones criticas faltantes");
    }
    if (Object.keys(BOOKING_FIELDS).length < 10) {
        issues.push("BOOKING_FIELDS incompleto");
    }
    if (SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS !== "BUSINESS") {
        issues.push(
            `VIOLACION_B3: TIME_SLOTS es ${SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS}, debe ser BUSINESS`
        );
    }
    if (FISCAL_LIMITS.CASHPAYMENT_MAX_EUR !== 1000) {
        issues.push("Limite efectivo incorrecto (Ley 11/2021: 1000 EUR)");
    }
    if (!ROL_BOOKINGS || !ROL_WEBSITE) {
        issues.push("ANEXO v8.1 C-02: ROL_BOOKINGS/ROL_WEBSITE faltantes");
    }
    if (BOOKING_TYPE.DUAL_F1 !== "DUAL_F1" || BOOKING_TYPE.DUAL_F2 !== "DUAL_F2") {
        issues.push("ADR-17: BOOKING_TYPE debe usar SNAKE_CASE (DUAL_F1/DUAL_F2)");
    }

    return {
        valid: issues.length === 0,
        issues,
        timestamp: Date.now(),
    };
}

export function validateRuntimeContext(context) {
    const errors = [];

    if (!context) {
        return { valid: false, errors: ["Contexto de ejecucion nulo"], timestamp: Date.now() };
    }
    if (!context.user || !context.user.role) {
        errors.push("Rol de usuario no definido");
    }
    if (!context.locationId) {
        errors.push("Location ID no definido");
    } else if (context.locationId !== SDK_CONFIG.LOCATION_ID) {
        errors.push(`Location ID invalido: ${context.locationId}`);
    }
    if (!context.timestamp || isNaN(new Date(context.timestamp).getTime())) {
        errors.push("Timestamp invalido");
    }

    return {
        valid: errors.length === 0,
        errors,
        timestamp: Date.now(),
    };
}