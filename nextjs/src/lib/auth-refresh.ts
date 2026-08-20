import { discoverOidc } from '@/lib/oidc'

export interface RefreshTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

export async function refreshAccessToken(token: {
  refreshToken?: string;
}): Promise<RefreshTokenResponse> {
  if (!token.refreshToken) {
    throw new Error("Missing refresh token");
  }

  const { token_endpoint } = await discoverOidc();

  const response = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.OIDC_CLIENT_ID!,
      client_secret: process.env.OIDC_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    }),
  });

  const refreshed = await response.json();
  if (!response.ok) {
    throw new Error(
      refreshed.error_description ??
        refreshed.error ??
        "Failed to refresh access token",
    );
  }

  return refreshed as RefreshTokenResponse;
}
