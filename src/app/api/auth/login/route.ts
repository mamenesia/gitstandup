import { NextResponse } from "next/server";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

export async function GET() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const redirectUrl = process.env.OAUTH_REDIRECT_URL;

  if (!clientId || !redirectUrl) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured on the server." },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUrl,
    scope: "repo",
    // Random state for CSRF protection; stored in a short-lived cookie.
    state: crypto.randomUUID(),
  });

  const authorizeUrl = `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;

  const res = NextResponse.redirect(authorizeUrl);
  // Short-lived cookie carrying the OAuth state for CSRF check in callback.
  res.cookies.set("oauth_state", params.get("state") as string, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 5, // 5 minutes
  });
  return res;
}
