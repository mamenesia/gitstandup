import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

interface RawUser {
  login: string;
  avatar_url: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("oauth_state")?.value;

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const homeUrl = process.env.APP_BASE_URL || "/";

  // CSRF check.
  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.redirect(new URL("/?auth_error=1", homeUrl));
  }

  try {
    // 1. Exchange the code for an access token.
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: process.env.OAUTH_REDIRECT_URL,
      }),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(new URL("/?auth_error=1", homeUrl));
    }

    const tokenBody = await tokenRes.json();
    const accessToken: string | undefined = tokenBody.access_token;
    if (!accessToken) {
      // e.g. user denied, or bad_code_used error.
      return NextResponse.redirect(new URL("/?auth_error=1", homeUrl));
    }

    // 2. Fetch the authenticated user's identity for display.
    const userRes = await fetch(`${GITHUB_API}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const user: RawUser = userRes.ok ? await userRes.json() : { login: "", avatar_url: "" };

    // 3. Save the session.
    const session = await getSession();
    session.accessToken = accessToken;
    session.login = user.login;
    session.avatarUrl = user.avatar_url;
    await session.save();

    const res = NextResponse.redirect(new URL("/", homeUrl));
    res.cookies.delete("oauth_state");
    return res;
  } catch {
    return NextResponse.redirect(new URL("/?auth_error=1", homeUrl));
  }
}
