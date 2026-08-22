import type { NextConfig } from "next";

export function createSecurityHeaders(isProduction: boolean) {
  return [
    {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data: https:",
        "font-src 'self' data:",
        "connect-src 'self' http://localhost:8080 http://127.0.0.1:8080 https:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(), geolocation=(), microphone=()",
    },
    ...(isProduction
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ]
      : []),
  ];
}

const securityHeaders = createSecurityHeaders(process.env.NODE_ENV === "production");

const nextConfig: NextConfig = {
  // Enable standalone output for Docker production builds
  // This creates a minimal server bundle without node_modules
  output: "standalone",

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },

  // Runs+Schedules merged into /orchestrate and Connections+Sources into /data.
  // The old paths stay linkable so existing bookmarks land on the right tab.
  async redirects() {
    return [
      { source: "/runs", destination: "/orchestrate", permanent: false },
      { source: "/schedules", destination: "/orchestrate?tab=schedules", permanent: false },
      { source: "/connections", destination: "/data", permanent: false },
      { source: "/sources", destination: "/data?tab=sources", permanent: false },
    ];
  },
};

export default nextConfig;
