import { NextResponse } from "next/server";
import { fetchUserRepos } from "@/lib/github";
import { getSession } from "@/lib/session";

/**
 * List the signed-in user's GitHub repos (public + private they can access),
 * sorted by last-updated descending. Powers the repo picker in the UI.
 */
export async function GET() {
  const session = await getSession();
  if (!session.accessToken) {
    return NextResponse.json(
      { error: "Sign in with GitHub to list repos." },
      { status: 401 }
    );
  }
  try {
    const repos = await fetchUserRepos(session.accessToken);
    return NextResponse.json({ repos });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list repos";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
