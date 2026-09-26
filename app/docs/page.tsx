"use client";

import Script from "next/script";
import { useEffect } from "react";

/**
 * Swagger UI for the VestFlow API (#210), pointed at the hand-authored
 * OpenAPI spec served from /api/openapi.
 *
 * Loaded from the CDN rather than the `swagger-ui-react` package to avoid
 * a new dependency with its own React peer-version constraints — this
 * repo is on React 19, and swagger-ui-react's React support has lagged
 * major React releases before.
 */
export default function ApiDocsPage() {
  useEffect(() => {
    const id = "swagger-ui-css";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/swagger-ui-dist@5/swagger-ui.css";
    document.head.appendChild(link);
  }, []);

  return (
    <>
      <div id="swagger-ui" />
      <Script
        src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"
        strategy="afterInteractive"
        onLoad={() => {
          // @ts-expect-error -- global provided by the swagger-ui-bundle script
          window.SwaggerUIBundle({
            url: "/api/openapi",
            dom_id: "#swagger-ui",
          });
        }}
      />
    </>
  );
}
