/**
 * security.config.ts
 *
 * Centralised security configuration consumed by main.ts.
 * This file is CISO-owned — do not add application logic here.
 *
 * Exports:
 *   helmetConfig          - Helmet options for production hardening
 *   helmetConfigSwagger   - Relaxed Helmet options that allow Swagger UI to render
 *   corsOptions           - CORS factory; call with the ALLOWED_ORIGINS env string
 *   BODY_SIZE_LIMIT       - Maximum accepted request body size
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

export const BODY_SIZE_LIMIT = '5mb';

// ---------------------------------------------------------------------------
// Helmet
// ---------------------------------------------------------------------------

/**
 * Production Helmet configuration.
 *
 * Threat addressed:
 *   - XSS via injected scripts (CSP + noSniff)
 *   - Clickjacking (frameOptions / frame-ancestors)
 *   - Protocol downgrade / MITM (HSTS)
 *   - MIME sniffing attacks (noSniff)
 *   - Referrer leakage to third parties (referrerPolicy)
 *
 * Used when ENABLE_SWAGGER is false (production / staging).
 */
export const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    // 1 year in seconds; includeSubDomains prevents subdomain downgrade attacks
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' as const },
  // X-Frame-Options is set via frameAncestors above; disable the legacy header
  // to avoid duplicate/conflicting directives on older clients
  frameguard: false,
};

/**
 * Swagger-mode Helmet configuration.
 *
 * Swagger UI requires:
 *   - unsafe-inline for its dynamically generated <style> and <script> blocks
 *   - data: URIs for inline SVG icons
 *
 * ONLY enable this in development/local environments where ENABLE_SWAGGER=true.
 * Never expose Swagger in production — the broader CSP here is intentional for
 * local DX only and is not acceptable in production.
 */
export const helmetConfigSwagger = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' as const },
  frameguard: false,
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * corsOptions — CORS configuration factory.
 *
 * @param allowedOriginsEnv  The raw value of process.env.ALLOWED_ORIGINS —
 *                           a comma-separated list of allowed origins.
 *                           Example: "http://localhost:5173,https://app.example.com"
 *
 * Threat addressed:
 *   - Cross-origin request forgery and data exfiltration via permissive CORS
 *   - Credential leakage to unapproved origins
 *
 * Security invariants enforced:
 *   1. Origins are whitelisted explicitly — wildcard (*) is never returned for
 *      credentialed requests.
 *   2. If ALLOWED_ORIGINS is absent or empty, CORS is denied for all origins
 *      (fails secure — the service operates in an API-only mode where the
 *      caller is responsible for network-level access control).
 *   3. Origin matching is exact string comparison (no prefix/suffix matching
 *      that could be bypassed with evil.example.com tricks).
 */
export function corsOptions(allowedOriginsEnv?: string): CorsOptions {
  const whitelist = new Set(
    (allowedOriginsEnv ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

  return {
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, origin?: boolean | string) => void,
    ) => {
      // Server-to-server / internal callers: browsers always send an Origin
      // header, so a missing Origin means the request originates from a
      // backend service, CLI tool, or health-check probe — not a browser.
      // Allowing these is intentional and correct.
      //
      // SECURITY ASSUMPTION: this service is deployed behind an internal
      // network boundary (VPC, private subnet, or mTLS peer authentication).
      // It must NOT be exposed directly to the public internet without a
      // network-level access control (e.g. API Gateway, load-balancer ACL,
      // or service mesh policy) in front of it. CORS is a browser-only
      // mechanism and provides zero protection against non-browser callers.
      if (!requestOrigin) {
        callback(null, true);
        return;
      }

      if (whitelist.has(requestOrigin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-ID',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Correlation-ID', 'X-Request-Id'],
    credentials: true,
    maxAge: 86400, // 24 h preflight cache
  };
}
