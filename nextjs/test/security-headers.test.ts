import { describe, expect, it } from "vitest";

import { createSecurityHeaders } from "../next.config";

describe("browser security headers", () => {
  it("sets the baseline without permissive CORS headers", () => {
    const headers = createSecurityHeaders(false);
    const values = Object.fromEntries(headers.map(({ key, value }) => [key, value]));

    expect(values["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(values["X-Content-Type-Options"]).toBe("nosniff");
    expect(values["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(values["X-Frame-Options"]).toBe("DENY");
    expect(values["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(values["Strict-Transport-Security"]).toBeUndefined();
  });

  it("adds HSTS for production", () => {
    const headers = createSecurityHeaders(true);
    const hsts = headers.find(({ key }) => key === "Strict-Transport-Security");

    expect(hsts?.value).toContain("max-age=63072000");
  });
});
