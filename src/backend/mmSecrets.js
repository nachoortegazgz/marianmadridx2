/*
=============================================================================
MODULE: backend/mmSecrets.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.5-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Nombres canonicos de secretos Wix.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. Los nombres de secretos son
            externos (Wix Secrets Manager) y no forman parte de la
            matriz V20.1.

CORRECTIONS (heredadas):
  [VF-01].
=============================================================================
*/

export const SECRETS = Object.freeze({
    // Fiscal (obligatorio Veri*factu)
    FISCAL_KEY: "SECRET_FISCALKEY",
    FISCAL_NIF_EMISOR: "FISCAL_NIF_EMISOR",

    // Firma X.509 delegada en microservicio externo
    FISCAL_SIGNER_ENDPOINT: "FISCAL_SIGNER_ENDPOINT",
    FISCAL_SIGNER_BEARER: "FISCAL_SIGNER_BEARER",

    // Autenticacion y roles
    AUTH_JWT_KEY: "SECRET_AUTH_JWT_KEY",
    ADMIN_EMAILS: "ADMIN_EMAILS",
    CAJERO_EMAILS: "CAJERO_EMAILS",

    // Automatizacion
    POWER_AUTOMATE: "POWER_AUTOMATE_TOKEN",

    // Email (SendGrid legacy + Resend actual)
    SENDGRID_API_KEY: "SENDGRID_API_KEY",
    SENDGRID_FROM_EMAIL: "SENDGRID_FROM_EMAIL",
    RESEND_API_KEY: "RESEND_API_KEY",
    RESEND_FROM_EMAIL: "RESEND_FROM_EMAIL",

    // Asistente IA
    MARIAN_ASSISTANT_OPENAI_KEY: "MARIAN_ASSISTANT_OPENAI_KEY",

    // Microsoft 365 Graph API
    M365_GRAPH_CLIENT_ID: "M365_CLIENT_ID",
    M365_GRAPH_CLIENT_SECRET: "M365_CLIENT_SECRET",
    M365_GRAPH_TENANT_ID: "M365_TENANT_ID",
    M365_GRAPH_SITE_ID: "M365_GRAPH_SITE_ID",
    M365_GRAPH_LIST_ID: "M365_LIST_ID",
    M365_WEBHOOK_HMAC_KEY: "SECRET_M365_WEBHOOK_HMAC_KEY",
});