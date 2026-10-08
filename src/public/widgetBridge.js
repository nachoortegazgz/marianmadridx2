// FILE: src/public/widgetBridge.js
/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5011-F1-CANONICAL
BASE NORMATIVA:
  - BIBLIA2 / BIBLIAV v5009-V20-FINAL-CONSOLIDATED-v4.2 (Bloque 1, D6, D10, R19)
  - CAMBIO.txt seccion 11 (cero duplicidades, cero alias)
  - Dossier CMS vivo 30/09/2026 (ServiciosCatalogo rev.88)
RESPONSABILIDAD: Frontera unica y segura entre paginas Velo y widgets HTML.
STANDARDS: G10 ASCII estricto. Modulo hoja (leaf).

RESTRICCION ACICLICA OBLIGATORIA
  widgetBridge.js NO debe importar public/mmUtils.js ni modulos de backend.
  mmUtils.js reexporta este protocolo como facade; el SSOT vive aqui.

CAMBIOS ROMPIENTES DE ALINEACION (grep antes de desplegar)
  1. MESSAGETYPES          -> MESSAGE_TYPES   (nombre canonico SCREAMING_SNAKE)
  2. Alias MESSAGE_TYPES / URLS / UI ELIMINADOS de este modulo.
     El facade corto (URLS, UI) lo provee public/mmUtils.js.
  3. replyToMessage() ELIMINADO (duplicado de reply() con args invertidos).
  4. bridge.onMessage ELIMINADO como metodo -> bridge.subscribe() canonico.
  5. options.onMessage ELIMINADO -> options.onWidgetMessage canonico.
  6. Tolerancias de entrada ELIMINADAS: messageType, eventType, data, id.
     Campos canonicos: type, payload, messageId, requestId, version.
  7. Respuestas *_RES ya no se admiten por patron abierto: solo se acepta
     <TIPO>_RES cuando <TIPO> esta en allowedTypes.
  8. Origen: validacion activa por defecto (strictOrigin) con allowlist de
     sufijos Wix; origenes opacos (blob:/data:/null) permitidos por defecto
     porque el HTML Component se monta sobre iframe opaco.
=============================================================================
*/

/* ============================================================================
 * 1. PROTOCOLO — SSOT
 * ==========================================================================*/

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
  READY: "MM_READY",
  CONTEXT: "MM_CONTEXT",
  AVAIL: "MM_AVAIL",
  SELECT: "MM_SELECT",
  BOOK: "MM_BOOK",
  NAV: "MM_NAV"
});

export const PROTOCOL_URLS = Object.freeze({
  SERVICIOS: "/reserva-online",
  CALENDARIO_2: "/booking-calendar/calendario-2",
  PRIVACY_POLICY: "/politica-de-privacidad"
});

/**
 * Timings de frontera. HANDSHAKE_TIMEOUT_MS y CONTEXT_TIMEOUT_MS dejan de
 * ser configuracion muerta: los consume el watchdog de este modulo.
 */
export const PROTOCOL_UI = Object.freeze({
  FRONTEND_API_TIMEOUT_MS: 60000,
  HANDSHAKE_TIMEOUT_MS: 15000,
  CONTEXT_TIMEOUT_MS: 30000
});

/* ============================================================================
 * 2. CONSTANTES DE PROTOCOLO Y SEGURIDAD
 * ==========================================================================*/

const RESPONSE_TYPE_SUFFIX = "_RES";
const RESPONSE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,38}_RES$/;
const ADMIN_RESPONSE_TYPE = "MM_ADMIN_RESPONSE";

const MAX_TYPE_LENGTH = 40;
const MAX_MESSAGE_ID_LENGTH = 120;
const MAX_MESSAGE_BYTES = 100000;
const MAX_PAYLOAD_KEYS = 400;

/** Allowlist por defecto de origenes Wix para el HTML Component. */
const DEFAULT_ALLOWED_ORIGIN_SUFFIXES = Object.freeze([
  ".parastorage.com",
  ".wix.com",
  ".wixsite.com",
  ".editorx.com"
]);

const OPAQUE_ORIGIN_PREFIXES = Object.freeze(["blob:", "data:", "filesystem:"]);

export const WIDGET_ERROR_CODE = Object.freeze({
  INVALID_WIDGET: "WIDGET_INVALID_HTML_COMPONENT",
  DESTROYED: "WIDGET_BRIDGE_DESTROYED",
  ORIGIN_REJECTED: "WIDGET_ORIGIN_REJECTED",
  ORIGIN_OPAQUE_REJECTED: "WIDGET_ORIGIN_OPAQUE_REJECTED",
  MESSAGE_TOO_LARGE: "WIDGET_MESSAGE_TOO_LARGE",
  PAYLOAD_TOO_COMPLEX: "WIDGET_PAYLOAD_TOO_COMPLEX",
  TYPE_MISSING: "WIDGET_MESSAGE_TYPE_MISSING",
  TYPE_NOT_ALLOWED: "WIDGET_MESSAGE_TYPE_NOT_ALLOWED",
  VERSION_UNSUPPORTED: "WIDGET_PROTOCOL_VERSION_UNSUPPORTED",
  MESSAGE_REJECTED: "WIDGET_MESSAGE_REJECTED",
  HANDSHAKE_TIMEOUT: "WIDGET_HANDSHAKE_TIMEOUT",
  CONTEXT_TIMEOUT: "WIDGET_CONTEXT_TIMEOUT",
  CONTEXT_FAILED: "WIDGET_CONTEXT_FAILED",
  LISTENER_FAILED: "WIDGET_MESSAGE_LISTENER_FAILED",
  HANDLER_FAILED: "WIDGET_MESSAGE_HANDLER_FAILED",
  CONSUMER_ERROR_HANDLER_FAILED: "WIDGET_ERROR_HANDLER_FAILED"
});

const DEFAULT_ALLOWED_TYPES = Object.freeze(Object.values(MESSAGE_TYPES));

const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

let instanceCounter = 0;

/* ============================================================================
 * 3. HELPERS INTERNOS
 * ==========================================================================*/

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeType(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .slice(0, MAX_TYPE_LENGTH);
}

function safeMessageId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "_")
    .slice(0, MAX_MESSAGE_ID_LENGTH);
}

function toProtocolVersion(value) {
  if (value === undefined || value === null || value === "") return PROTOCOL_VERSION;

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function estimateBytes(value) {
  try {
    const serialized = JSON.stringify(value);

    if (typeof serialized !== "string") return MAX_MESSAGE_BYTES + 1;

    return textEncoder ? textEncoder.encode(serialized).length : serialized.length;
  } catch (error) {
    // Estructura circular o no serializable: se trata como exceso de tamano.
    return MAX_MESSAGE_BYTES + 1;
  }
}

function countKeys(value) {
  if (!value || typeof value !== "object") return 0;

  let total = 0;
  const stack = [value];

  while (stack.length > 0 && total <= MAX_PAYLOAD_KEYS) {
    const current = stack.pop();

    if (!current || typeof current !== "object") continue;

    const keys = Object.keys(current);
    total += keys.length;

    for (let index = 0; index < keys.length; index += 1) {
      const child = current[keys[index]];
      if (child && typeof child === "object") stack.push(child);
    }
  }

  return total;
}

export function buildResponseType(type) {
  return `${safeType(type)}${RESPONSE_TYPE_SUFFIX}`;
}

function isResponseType(type) {
  return RESPONSE_TYPE_PATTERN.test(type);
}

function getResponseTypeBase(type) {
  return isResponseType(type) ? type.slice(0, -RESPONSE_TYPE_SUFFIX.length) : "";
}

function resolveOriginPolicy(options) {
  const exact = String(options.allowedOrigin ?? "").trim().toLowerCase();

  if (exact) {
    return Object.freeze({
      mode: "exact",
      exact,
      suffixes: Object.freeze([]),
      allowOpaqueOrigin: options.allowOpaqueOrigin !== false
    });
  }

  const custom = Array.isArray(options.allowedOriginSuffixes)
    ? options.allowedOriginSuffixes
        .map((suffix) => String(suffix ?? "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  const strict = options.strictOrigin !== false;

  return Object.freeze({
    mode: strict ? "suffix" : "off",
    exact: "",
    suffixes: Object.freeze(custom.length > 0 ? custom : DEFAULT_ALLOWED_ORIGIN_SUFFIXES),
    allowOpaqueOrigin: options.allowOpaqueOrigin !== false
  });
}

function classifyOrigin(rawOrigin) {
  const origin = String(rawOrigin ?? "").trim().toLowerCase();

  if (!origin || origin === "null") {
    return { opaque: true, value: origin };
  }

  const isOpaque = OPAQUE_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));

  return { opaque: isOpaque, value: origin };
}

function getOriginHost(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (error) {
    return origin.replace(/^[a-z0-9+.-]+:\/\//i, "").split("/")[0].toLowerCase();
  }
}

function isOriginAllowed(origin, policy) {
  if (policy.mode === "off") return true;

  if (policy.mode === "exact") return origin === policy.exact;

  const host = getOriginHost(origin);

  return policy.suffixes.some((suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix));
}

function withManagedTimeout(promise, timeoutMs, code, timers) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      timers.delete(timer);

      const error = new Error(code);
      error.code = code;

      reject(error);
    }, Math.max(1, Number(timeoutMs) || 1));

    timers.add(timer);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        timers.delete(timer);

        resolve(value);
      },
      (error) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        timers.delete(timer);

        reject(error);
      }
    );
  });
}

/* ============================================================================
 * 4. FABRICA DEL BRIDGE
 * ==========================================================================*/

export function createWidgetBridge(widgetElement, options = {}) {
  if (
    !widgetElement ||
    typeof widgetElement.onMessage !== "function" ||
    typeof widgetElement.postMessage !== "function"
  ) {
    const error = new TypeError(WIDGET_ERROR_CODE.INVALID_WIDGET);
    error.code = WIDGET_ERROR_CODE.INVALID_WIDGET;

    throw error;
  }

  const settings = safeObject(options);

  instanceCounter += 1;
  const bridgeId = `wbridge-${instanceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const originPolicy = resolveOriginPolicy(settings);
  const allowedTypes = new Set(
    Array.isArray(settings.allowedTypes) && settings.allowedTypes.length > 0
      ? settings.allowedTypes.map(safeType).filter(Boolean)
      : DEFAULT_ALLOWED_TYPES
  );

  const handshakeTimeoutMs = Number(settings.handshakeTimeoutMs) > 0
    ? Number(settings.handshakeTimeoutMs)
    : PROTOCOL_UI.HANDSHAKE_TIMEOUT_MS;

  const contextTimeoutMs = Number(settings.contextTimeoutMs) > 0
    ? Number(settings.contextTimeoutMs)
    : PROTOCOL_UI.CONTEXT_TIMEOUT_MS;

  const onWidgetMessage = typeof settings.onWidgetMessage === "function" ? settings.onWidgetMessage : null;
  const onContextReady = typeof settings.onContextReady === "function" ? settings.onContextReady : null;
  const onError = typeof settings.onError === "function" ? settings.onError : () => {};

  let destroyed = false;
  let sequence = 0;
  let handshakeCompleted = false;
  let contextInFlight = false;
  let bridge = null;

  const listeners = new Set();
  const timers = new Set();

  function isAllowedType(type) {
    if (allowedTypes.has(type)) return true;
    if (type === ADMIN_RESPONSE_TYPE) return true;

    const base = getResponseTypeBase(type);

    return Boolean(base) && allowedTypes.has(base);
  }

  function fail(code, detail = null) {
    const error = new Error(code);
    error.code = code;
    error.bridgeId = bridgeId;

    if (detail !== null && detail !== undefined) {
      error.detail = detail;
    }

    try {
      onError(error, detail);
    } catch (consumerError) {
      // El manejador de errores del consumidor nunca debe romper el bridge.
    }

    return error;
  }

  function clearAllTimers() {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  }

  function extractEvent(event) {
    const classified = classifyOrigin(event?.origin);

    if (classified.opaque) {
      if (!originPolicy.allowOpaqueOrigin) {
        fail(WIDGET_ERROR_CODE.ORIGIN_OPAQUE_REJECTED, { origin: classified.value });
        return null;
      }
    } else if (!isOriginAllowed(classified.value, originPolicy)) {
      fail(WIDGET_ERROR_CODE.ORIGIN_REJECTED, { origin: classified.value });
      return null;
    }

    const message = safeObject(event?.data);

    if (estimateBytes(message) > MAX_MESSAGE_BYTES) {
      fail(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
      return null;
    }

    if (countKeys(message) > MAX_PAYLOAD_KEYS) {
      fail(WIDGET_ERROR_CODE.PAYLOAD_TOO_COMPLEX);
      return null;
    }

    return message;
  }

  function normalizeMessage(source) {
    const type = safeType(source.type);

    if (!type) {
      return { message: null, code: WIDGET_ERROR_CODE.TYPE_MISSING };
    }

    if (!isAllowedType(type)) {
      return { message: null, code: WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED };
    }

    const version = toProtocolVersion(source.version);

    if (version !== PROTOCOL_VERSION) {
      return { message: null, code: WIDGET_ERROR_CODE.VERSION_UNSUPPORTED };
    }

    const messageId = safeMessageId(source.messageId);

    return {
      message: Object.freeze({
        type,
        payload: Object.freeze(safeObject(source.payload)),
        messageId,
        requestId: safeMessageId(source.requestId) || messageId,
        version: PROTOCOL_VERSION,
        bridgeId
      }),
      code: null
    };
  }

  function notifyListeners(message) {
    listeners.forEach((listener) => {
      try {
        listener(message, bridge);
      } catch (error) {
        fail(WIDGET_ERROR_CODE.LISTENER_FAILED, error);
      }
    });
  }

  function nextMessageId() {
    sequence += 1;

    return safeMessageId(
      `${bridgeId}-${Date.now().toString(36)}-${sequence.toString(36)}`
    );
  }

  function send(type, payload = {}, messageId = null) {
    if (destroyed) {
      const error = new Error(WIDGET_ERROR_CODE.DESTROYED);
      error.code = WIDGET_ERROR_CODE.DESTROYED;

      throw error;
    }

    const normalizedType = safeType(type);

    if (!isAllowedType(normalizedType)) {
      const error = new Error(WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED);
      error.code = WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED;

      throw error;
    }

    const message = Object.freeze({
      type: normalizedType,
      payload: safeObject(payload),
      messageId: safeMessageId(messageId) || nextMessageId(),
      version: PROTOCOL_VERSION,
      bridgeId
    });

    if (estimateBytes(message) > MAX_MESSAGE_BYTES) {
      const error = new Error(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
      error.code = WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE;

      throw error;
    }

    widgetElement.postMessage(message);

    return message.messageId;
  }

  function resolveCorrelationId(requestMessage) {
    if (!requestMessage) return "";

    if (typeof requestMessage === "string") return safeMessageId(requestMessage);

    if (typeof requestMessage !== "object") return "";

    return safeMessageId(requestMessage.messageId) || safeMessageId(requestMessage.requestId);
  }

  function reply(type, payload = {}, requestMessage = null) {
    return send(type, payload, resolveCorrelationId(requestMessage) || null);
  }

  function postMessage(payload = {}, type = MESSAGE_TYPES.CONTEXT) {
    return send(type, payload);
  }

  function subscribe(callback) {
    if (destroyed || typeof callback !== "function") {
      return () => {};
    }

    listeners.add(callback);

    return () => {
      listeners.delete(callback);
    };
  }

  function publishContext(message) {
    if (!onContextReady || contextInFlight) return;

    contextInFlight = true;

    withManagedTimeout(
      Promise.resolve().then(() => onContextReady(message, bridge)),
      contextTimeoutMs,
      WIDGET_ERROR_CODE.CONTEXT_TIMEOUT,
      timers
    )
      .then((context) => {
        contextInFlight = false;

        if (destroyed || context === undefined || context === null) return;

        send(MESSAGE_TYPES.CONTEXT, context, message.messageId || null);
      })
      .catch((error) => {
        contextInFlight = false;

        fail(
          error?.code === WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
            ? WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
            : WIDGET_ERROR_CODE.CONTEXT_FAILED,
          error
        );
      });
  }

  function armHandshakeWatchdog() {
    if (!onContextReady || handshakeTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      timers.delete(timer);

      if (destroyed || handshakeCompleted) return;

      fail(WIDGET_ERROR_CODE.HANDSHAKE_TIMEOUT, { bridgeId });
    }, handshakeTimeoutMs);

    timers.add(timer);
  }

  const unsubscribeWidget = widgetElement.onMessage((event) => {
    if (destroyed) return;

    try {
      const extracted = extractEvent(event);

      if (!extracted) return;

      const normalized = normalizeMessage(extracted);

      if (!normalized.message) {
        fail(normalized.code || WIDGET_ERROR_CODE.MESSAGE_REJECTED);
        return;
      }

      const message = normalized.message;

      if (message.type === MESSAGE_TYPES.READY) {
        handshakeCompleted = true;
      }

      notifyListeners(message);

      if (onWidgetMessage) {
        Promise.resolve()
          .then(() => onWidgetMessage(message, bridge))
          .catch((error) => {
            fail(error?.code || WIDGET_ERROR_CODE.HANDLER_FAILED, error);
          });
      }

      if (message.type === MESSAGE_TYPES.READY) {
        publishContext(message);
      }
    } catch (error) {
      fail(error?.code || WIDGET_ERROR_CODE.HANDLER_FAILED, error);
    }
  });

  armHandshakeWatchdog();

  bridge = Object.freeze({
    type: "WIX_HTML_COMPONENT_BRIDGE",
    bridgeId,
    protocolVersion: PROTOCOL_VERSION,
    widget: widgetElement,
    originPolicyMode: originPolicy.mode,
    allowedTypes: Object.freeze(Array.from(allowedTypes)),

    get destroyed() {
      return destroyed;
    },

    get handshakeCompleted() {
      return handshakeCompleted;
    },

    send,
    reply,
    postMessage,
    subscribe,

    destroy() {
      if (destroyed) return;

      destroyed = true;

      listeners.clear();
      clearAllTimers();

      if (typeof unsubscribeWidget === "function") {
        try {
          unsubscribeWidget();
        } catch (error) {
          // El widget ya puede estar desmontado; la baja es idempotente.
        }
      }
    }
  });

  return bridge;
}

export default createWidgetBridge;
