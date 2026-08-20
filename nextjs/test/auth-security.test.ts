import { afterEach, describe, expect, it, vi } from "vitest";

import { authConfig } from "../src/lib/auth.config";
import { isMalformedBearerHeader } from "../src/lib/auth-headers";
import { refreshAccessToken } from "../src/lib/auth-refresh";

describe("authentication security boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects malformed Bearer headers", () => {
    expect(isMalformedBearerHeader(null)).toBe(false);
    expect(isMalformedBearerHeader("Bearer signed.jwt.value")).toBe(false);
    expect(isMalformedBearerHeader("Basic credentials")).toBe(true);
    expect(isMalformedBearerHeader("Bearer")).toBe(true);
    expect(isMalformedBearerHeader("Bearer token with-spaces")).toBe(true);
  });

  it("keeps OAuth sessions in the server-managed JWT cookie", () => {
    expect(authConfig.session?.strategy).toBe("jwt");
    expect(authConfig).not.toHaveProperty("cookies");
  });

  it("does not retain an access token when refresh is expired", async () => {
    process.env.OIDC_ISSUER = "https://idp.test/realms/ci";

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // Two calls: OIDC discovery, then the token endpoint.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ token_endpoint: "https://idp.test/token" }),
        )
        .mockResolvedValueOnce(
          json(
            {
              error: "invalid_grant",
              error_description: "Token is not active",
            },
            400,
          ),
        ),
    );

    await expect(
      refreshAccessToken({ refreshToken: "expired-refresh-token" }),
    ).rejects.toThrow("Token is not active");
  });

  it("refuses to refresh against an issuer with no discovery document", async () => {
    process.env.OIDC_ISSUER = "https://broken.test/realms/ci";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    );

    await expect(
      refreshAccessToken({ refreshToken: "some-refresh-token" }),
    ).rejects.toThrow("OIDC discovery failed");
  });
});
