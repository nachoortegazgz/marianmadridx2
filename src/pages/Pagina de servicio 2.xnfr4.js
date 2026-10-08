/*
=============================================================================
MODULE: pages/servicio-2.js
VERSION: v5012-SERVICE-CATALOG-CLEAN
=============================================================================
*/

import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
  MESSAGE_TYPES,
  URLS,
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

const EXCLUDED_PATHS = new Set([
  "servicios",
  "service",
  "servicio",
  "servicio-2"
]);

let bridge = null;
let resolvedService = null;

function text(value, fallback = "") {
  return _safeTrim(value) || fallback;
}

function getSafeMessage(error, fallback) {
  return text(error?.message, fallback);
}

function showError(message) {
  const safeMessage = text(message, "No se pudo cargar el servicio.");

  console.error("[servicio-2] Error:", safeMessage);

  try {
    const banner = $w("#errorBanner");
    if (!banner) return;

    banner.text = `Error: ${safeMessage}`;
    if (typeof banner.show === "function") {
      banner.show();
    }
  } catch (error) {
    console.warn(
      "[servicio-2] No se pudo mostrar el error:",
      error?.message
    );
  }
}

function getMessageType(message) {
  if (!message || typeof message !== "object") return "";
  return text(message.type || message.action).toUpperCase();
}

function getPayload(message) {
  const payload = message?.payload;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload;
}

function getReferenceId(value) {
  if (typeof value === "string") {
    return text(value);
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  return text(
    value.serviceId ||
    value.addOnId ||
    value.nativeId ||
    value._id ||
    value.id ||
    value.value
  );
}

function getServiceId(service) {
  return getReferenceId(service?.serviceId);
}

function getServiceSlug(service) {
  return _safeSlugOrId(service?.slug || "");
}

function getLinkedPhaseId(value) {
  return getReferenceId(Array.isArray(value) ? value[0] : value);
}

function getAddOnOptions(service) {
  return Array.isArray(service?.addOnOptions) ? service.addOnOptions : [];
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeService(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("El servicio recibido no es válido.");
  }

  const serviceId = getServiceId(data);
  const slug = getServiceSlug(data);

  if (!_looksLikeGuid(serviceId)) {
    throw new Error("El servicio no tiene un serviceId válido.");
  }

  if (!slug) {
    throw new Error("El servicio no tiene un slug válido.");
  }

  return {
    serviceId,
    slug,
    title: text(data.title),
    description: text(data.description),
    location: text(data.location),
    totalDuration: toFiniteNumber(data.totalDuration),
    price: toFiniteNumber(data.price),
    mainMedia: text(data.mainMedia),
    addOnOptions: getAddOnOptions(data),
    linkedPhases: getLinkedPhaseId(data.linkedPhases),
    availableStaff: Array.isArray(data.availableStaff)
      ? data.availableStaff
      : [],
    clientHidden: Boolean(data.clientHidden),
    allowCombine: Boolean(data.allowCombine)
  };
}

function resolveServiceLookup() {
  const query = wixLocation.query || {};

  for (const candidate of [query.slug, query.serviceId]) {
    const value = _safeSlugOrId(candidate);
    if (value) return value;
  }

  const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
  const value = _safeSlugOrId(path[path.length - 1] || "");

  if (!value || EXCLUDED_PATHS.has(value)) {
    return null;
  }

  return value;
}

function getAddOnIds(payload) {
  if (!Array.isArray(payload?.addOnIds)) return [];

  return [
    ...new Set(
      payload.addOnIds
        .map(getReferenceId)
        .filter(Boolean)
    )
  ].slice(0, 21);
}

function buildBookingUrl(service, payload) {
  const base = text(
    URLS?.CALENDARIO_2,
    "/booking-calendar/calendario-2"
  );

  const query = new URLSearchParams({
    slug: getServiceSlug(service),
    serviceId: getServiceId(service),
    referral: "servicio-2"
  });

  const addOnIds = getAddOnIds(payload);
  if (addOnIds.length > 0) {
    query.set("addOnIds", addOnIds.join(","));
  }

  return `${base}?${query.toString()}`;
}

function getServicesUrl() {
  return text(URLS?.SERVICIOS, "/reserva-online");
}

async function loadService(lookupValue) {
  const result = await getServiceBySlugOrId(lookupValue);

  if (
    result?.status !== "SUCCESS" ||
    !result.data ||
    typeof result.data !== "object"
  ) {
    throw new Error(
      result?.error?.message || "Servicio no encontrado."
    );
  }

  return normalizeService(result.data);
}

$w.onReady(async () => {
  const traceId = makeTraceId("servicio");

  let widget;
  try {
    widget = $w("#htmlWidgetCustomService");
  } catch (error) {
    showError("El widget del servicio no está disponible.");
    return;
  }

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    showError("El widget del servicio no está disponible.");
    return;
  }

  try {
    const lookupValue = resolveServiceLookup();

    if (!lookupValue) {
      showError("No se pudo localizar el servicio en la URL.");
      return;
    }

    bridge = createWidgetBridge(widget, {
      slug: lookupValue,
      traceId,

      onContextReady: async () => {
        resolvedService = await loadService(lookupValue);
        return resolvedService;
      },

      onWidgetMessage: async (message) => {
        const type = getMessageType(message);
        const payload = getPayload(message);

        if (!resolvedService) {
          console.warn(
            "[servicio-2] Servicio aún no disponible",
            { traceId, type }
          );
          return;
        }

        if (type === MESSAGE_TYPES.BOOK) {
          wixLocation.to(buildBookingUrl(resolvedService, payload));
          return;
        }

        if (type === MESSAGE_TYPES.NAV) {
          const target = text(payload.target).toUpperCase();
          if (!target || target === "SERVICIOS") {
            wixLocation.to(getServicesUrl());
          }
          return;
        }

        if (
          type === MESSAGE_TYPES.READY ||
          type === MESSAGE_TYPES.CONTEXT
        ) {
          return;
        }

        console.warn(
          "[servicio-2] Mensaje no soportado",
          { traceId, type }
        );
      },

      onError: (error) => {
        showError(
          getSafeMessage(error, "No se pudo cargar el servicio.")
        );
      }
    });

    if (!bridge) {
      showError("No se pudo inicializar el widget del servicio.");
    }
  } catch (error) {
    console.error("[servicio-2] Error de inicialización", {
      traceId,
      message: error?.message
    });

    showError(
      getSafeMessage(error, "No se pudo cargar el servicio.")
    );
  }
});
