import { getIronSession, SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface SessionData {
  accessToken?: string;
  login?: string;
  avatarUrl?: string;
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET as string,
  cookieName: "gitstandup_session",
  cookieOptions: {
    // Override to false in dev if testing over plain http.
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
};

/**
 * Get the current session. Must be awaited in Next 15+ (cookies() is async).
 */
export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions);
}
