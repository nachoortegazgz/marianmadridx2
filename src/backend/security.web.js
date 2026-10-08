/*
=============================================================================
MODULE: backend/security.web.js
VERSION: v5010.1-SECURITY
BASE: v5007.1-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Web methods de seguridad para frontend.
               Delegacion exclusiva en backend/security.js.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5010.1-SECURITY:
  - C-02: checkStaffCollaboratorAccess devuelve ahora el contrato
          {isMarianManager, isAdmin, isCajero} que consume
          pages/ADMINISTRACION.gn7mx.js. Antes devolvia {authorized, role};
          la propiedad isMarianManager nunca existia y la pagina protegida
          redirigia indefinidamente (bucle de acceso).
  - Roles leidos via backend/security.js (isAdmin / isCajero /
    isStaffCollaborator), que consultan MapaStaff.staffRole (C-01).
  - La denegacion se envuelve igualmente en successResponse: la verificacion
    se completa OK; es la AUTORIZACION la que vale false. Nunca se expone
    stack ni secrets al frontend (R11).

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo no importa constantes
            renombradas ni toca campos CMS con nomenclatura cambiada.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "backend/dataAccess";
import { members } from "@wix/members";

import { makeTraceId } from "public/mmUtils";

import {
    isAdmin,
    isCajero,
    isStaffCollaborator,
} from "backend/security";

import { STAFF_ACCESS } from "backend/internalConfig";

import {
    successResponse,
    errorResponse,
} from "backend/responseUtils";

// =============================================================================
// BLOQUE 1 - HELPERS INTERNOS
// =============================================================================

function _resolveTraceId(options, prefix) {
    const suppliedTraceId =
        options &&
        typeof options === "object" &&
        typeof options.traceId === "string" ?
        options.traceId.trim() :
        "";

    return suppliedTraceId || makeTraceId(prefix);
}

function _createAccessResponse(authorized, role) {
    return successResponse({
        authorized: authorized === true,
        role: authorized === true ? role : null,
    });
}

function _handleSecurityError(error, fallbackCode) {
    return errorResponse(
        error?.code || fallbackCode,
        error?.message || "No se pudo verificar el acceso."
    );
}

// =============================================================================
// BLOQUE 2 - CHECK ADMIN ACCESS
// =============================================================================

export const checkAdminAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-admin");

        try {
            const authorized = await isAdmin(traceId);

            return _createAccessResponse(authorized, "ADMIN");
        } catch (error) {
            return _handleSecurityError(error, "SEC_ADMIN_FAIL");
        }
    }
);

// =============================================================================
// BLOQUE 3 - CHECK CAJERO ACCESS
// =============================================================================

export const checkCajeroAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-cajero");

        try {
            const authorized = await isCajero(traceId);

            return _createAccessResponse(authorized, "CAJERO");
        } catch (error) {
            return _handleSecurityError(error, "SEC_CAJERO_FAIL");
        }
    }
);

// =============================================================================
// BLOQUE 4 - CHECK STAFF COLLABORATOR ACCESS (CONTRATO ADMINISTRACION)
// Devuelve { isMarianManager, isAdmin, isCajero }.
// isMarianManager: miembro autenticado cuyo email esta dado de alta
// en MapaStaff con resourceId = STAFF_ACCESS.MARIAN_RESOURCE_ID y rol ADMIN
// (identidad Marian). Fail-closed: cualquier duda deniega.
// =============================================================================

async function _isMarianManagerIdentity(traceId) {
    try {
        const contact = await members.getCurrentMember().catch(() => null);

        const email = String(
            contact?.loginEmail || contact?.contactDetails?.email || contact?.email || ""
        ).trim().toLowerCase();

        if (!email) {
            return false;
        }

        const res = await wixData
            .query("MapaStaff")
            .eq("email", email)
            .eq("resourceId", STAFF_ACCESS.MARIAN_RESOURCE_ID)
            .limit(1)
            .find({ suppressAuth: true });

        return Boolean(res?.items?.[0]);
    } catch (error) {
        return false;
    }
}

export const checkStaffCollaboratorAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-staff");

        try {
            const [collaborator, admin, cashier] = await Promise.all([
                isStaffCollaborator(traceId),
                isAdmin(traceId),
                isCajero(traceId),
            ]);

            const marianManager = collaborator === true
                ? await _isMarianManagerIdentity(traceId)
                : false;

            return successResponse({
                // Contrato consumido por ADMINISTRACION.gn7mx.js (C-02):
                isMarianManager: marianManager === true,
                isAdmin: admin === true,
                isCajero: cashier === true,
                // Campos informativos retrocompatibles:
                isStaffCollaborator: collaborator === true,
                authorized: collaborator === true,
                role: collaborator === true
                    ? (marianManager ? "ADMIN" : (cashier ? "GESTION" : "ESTILISTA"))
                    : null,
            });
        } catch (error) {
            return _handleSecurityError(error, "SEC_STAFF_FAIL");
        }
    }
);
