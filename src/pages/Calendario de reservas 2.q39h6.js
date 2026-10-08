/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.4-FUNCTIONAL
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location-frontend";
import wixWindowFrontend from "wix-window-frontend";

import {
    getServiceBySlugOrId,
    getAvailableDays,
    getAvailableSlots,
    getCertifiedDualSlots,
    resolveStaffForSlot
} from "backend/reservas.web.js";

import {
    MESSAGE_TYPES,
    URLS,
    UI,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    withTimeout
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web.js";

let currentServiceId = null;
let currentSlug = null;
let currentService = null;
let bridge = null;

function parseUrlParams() {
    const query = wixLocation.query || {};

    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeSlugOrId(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: _safeTrim(query.addOnIds || "")
            .split(",")
            .map(_safeTrim)
            .filter(Boolean)
    };
}

function resolveServiceFromParams(params) {
    if (params.serviceId && _looksLikeGuid(params.serviceId)) {
        return {
            serviceId: params.serviceId,
            slug: params.slug || null
        };
    }

    if (params.slug) {
        return {
            serviceId: null,
            slug: params.slug
        };
    }

    return null;
}

function getMessageType(message) {
    return String(
        message && (message.type || message.action) || ""
    ).trim().toUpperCase();
}

function getPayload(message) {
    if (
        message &&
        message.payload &&
        typeof message.payload === "object" &&
        !Array.isArray(message.payload)
    ) {
        return message.payload;
    }

    return {};
}

function createResultError(code, message) {
    return {
        status: "ERROR",
        data: null,
        error: { code, message }
    };
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);

    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(
            result?.error?.message ||
            "No se pudo cargar el servicio."
        );
    }

    currentService = result.data;

    return {
        ...result.data,
        serviceId: result.data.serviceId || currentServiceId,
        slug: result.data.slug || currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds,
        timeZone: "Europe/Madrid",
        currency: result.data.currency || "EUR"
    };
}

async function handleNavigation(payload) {
    const target = _safeTrim(payload?.target || "").toUpperCase();

    if (target === "SERVICIOS") {
        wixLocation.to(URLS?.SERVICIOS || "/reserva-online");
        return true;
    }

    if (target === "PRIVACY") {
        wixLocation.to(
            URLS?.PRIVACY_POLICY || "/politica-de-privacidad"
        );
        return true;
    }

    return false;
}

async function handleAvailability(payload, reply) {
    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = Array.isArray(payload.addOnIds)
        ? payload.addOnIds
        : [];
    let result;

    try {
        if (action === "days") {
            result = await withTimeout(
                getAvailableDays(
                    currentServiceId || currentSlug,
                    payload.resourceId || null,
                    Number(payload.year),
                    Number(payload.month),
                    addOnIds
                ),
                UI?.FRONTEND_API_TIMEOUT_MS || 60000,
                "getAvailableDays"
            );
        } else if (action === "slots") {
            result = await withTimeout(
                currentService?.allowCombine
                    ? getCertifiedDualSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        _safeTrim(payload.dateYMD || payload.dateYmd || ""),
                        addOnIds
                    )
                    : getAvailableSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        _safeTrim(payload.dateYMD || payload.dateYmd || ""),
                        addOnIds
                    ),
                UI?.FRONTEND_API_TIMEOUT_MS || 60000,
                "getAvailableSlots"
            );
        } else {
            result = createResultError(
                "INVALID_AVAILABILITY_REQUEST",
                "Solicitud de disponibilidad no valida."
            );
        }
    } catch (error) {
        result = createResultError(
            "AVAILABILITY_FAILED",
            error?.message || "No se pudo obtener disponibilidad."
        );
    }

    reply(
        MESSAGE_TYPES.AVAIL,
        {
            ...(result || createResultError(
                "EMPTY_AVAILABILITY_RESPONSE",
                "No se recibio disponibilidad."
            )),
            action,
            requestSequence: payload.requestSequence || 0
        },
        payload
    );
}

async function handleSelection(payload, reply) {
    const start = _safeTrim(payload.localStartDate || "");

    if (!start) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError(
                "INVALID_SLOT",
                "El horario seleccionado no es valido."
            ),
            payload
        );
        return;
    }

    try {
        const result = await withTimeout(
            resolveStaffForSlot(
                currentServiceId || currentSlug,
                start,
                payload.resourceId || null,
                Array.isArray(payload.addOnIds)
                    ? payload.addOnIds
                    : [],
                null
            ),
            UI?.FRONTEND_API_TIMEOUT_MS || 60000,
            "resolveStaffForSlot"
        );

        reply(
            MESSAGE_TYPES.SELECT,
            result || createResultError(
                "STAFF_RESOLVE_FAILED",
                "No se pudo validar el profesional."
            ),
            payload
        );
    } catch (error) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError(
                "STAFF_RESOLVE_FAILED",
                error?.message || "No se pudo validar el profesional."
            ),
            payload
        );
    }
}

async function handleBooking(message, reply, traceId) {
    const payload = getPayload(message);
    const bookingData =
        payload.bookingData &&
        typeof payload.bookingData === "object"
            ? payload.bookingData
            : payload;

    if (!bookingData || typeof bookingData !== "object") {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_BOOKING_PAYLOAD",
                "Los datos de la reserva no son validos."
            ),
            message
        );
        return;
    }

    const requestPayload = {
        ...bookingData,
        serviceId: bookingData.serviceId || currentServiceId,
        slug: bookingData.slug || currentSlug,
        traceId
    };

    try {
        const result = await withTimeout(
            processDualBooking(requestPayload),
            UI?.FRONTEND_API_TIMEOUT_MS || 60000,
            "processDualBooking"
        );

        const bookingResult = result || createResultError(
            "EMPTY_BOOKING_RESPONSE",
            "No se recibio respuesta de la reserva."
        );

        reply(MESSAGE_TYPES.BOOK, bookingResult, message);

        if (bookingResult.status === "SUCCESS") {
            try {
                await wixWindowFrontend.openLightbox(
                    "ConfirmacionReserva",
                    {
                        booking: bookingResult.data || null,
                        service: currentService,
                        traceId
                    }
                );
            } catch (lightboxError) {
                console.error(
                    "[calendario-2] No se pudo abrir ConfirmacionReserva",
                    {
                        traceId,
                        message: lightboxError?.message
                    }
                );
            }
        }
    } catch (error) {
        const timeout =
            error?.code === "TIMEOUT" ||
            String(error?.message || "")
                .toUpperCase()
                .includes("TIMEOUT");

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                timeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
                timeout
                    ? "La reserva esta tardando demasiado. Intentalo de nuevo."
                    : "No se pudo completar la reserva."
            ),
            message
        );
    }
}

$w.onReady(async () => {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);

    if (!resolved) {
        console.error("[calendario-2] Servicio no valido", { traceId });
        return;
    }

    currentServiceId = resolved.serviceId;
    currentSlug = resolved.slug;

    const widget = $w("#htmlWidgetCalendario");

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        console.error("[calendario-2] Widget HTML no disponible", { traceId });
        return;
    }

    try {
        bridge = createWidgetBridge(widget, {
            onContextReady: async () => loadServiceContext(params),

            onWidgetMessage: async (message, reply) => {
                const type = getMessageType(message);
                const payload = getPayload(message);

                if (type === MESSAGE_TYPES.NAV) {
                    await handleNavigation(payload);
                    return;
                }

                if (type === MESSAGE_TYPES.AVAIL) {
                    await handleAvailability(payload, reply);
                    return;
                }

                if (type === MESSAGE_TYPES.SELECT) {
                    await handleSelection(payload, reply);
                    return;
                }

                if (type === MESSAGE_TYPES.BOOK) {
                    await handleBooking(message, reply, traceId);
                    return;
                }

                if (
                    type !== MESSAGE_TYPES.READY &&
                    type !== MESSAGE_TYPES.CONTEXT
                ) {
                    console.warn(
                        "[calendario-2] Mensaje no soportado",
                        { traceId, type }
                    );
                }
            },

            onError: (error) => {
                console.error(
                    "[calendario-2] Error de comunicacion",
                    {
                        traceId,
                        message: error?.message
                    }
                );
            }
        });

        if (!bridge) {
            throw new Error("No se pudo inicializar el bridge.");
        }
    } catch (error) {
        console.error(
            "[calendario-2] Error de inicializacion",
            {
                traceId,
                message: error?.message
            }
        );
    }
});
