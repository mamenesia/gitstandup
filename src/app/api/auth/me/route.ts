import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

/**
 * Returns the signed-in user's identity, or 401 if no session.
 * The frontend uses this to decide between the login button and the
 * signed-in avatar + logout.
 */
export async function GET() {
  const session = await getSession();
  if (!session.accessToken || !session.login) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    login: session.login,
    avatarUrl: session.avatarUrl,
  });
}
