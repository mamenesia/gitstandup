import { NextRequest, NextResponse } from "next/server";
import {
  fetchPRs,
  fetchIssues,
  fetchCommits,
  fetchReviews,
  groupByAuthor,
  type PullRequest,
  type Issue,
  type Commit,
  type Review,
} from "@/lib/github";
import { generateStandups, type DayActivityInput } from "@/lib/ai";
import { getSession } from "@/lib/session";

interface StandupResponse {
  login: string;
  avatar_url: string;
  summary: string;
  dailySummaries: Record<string, string>;
  byDay: Record<string, DayActivityInput>;
}

interface StatsResponse {
  contributors: number;
  prs: number;
  issues: number;
  commits: number;
  reviews: number;
}

const MAX_REPOS = 5;

/**
 * Parse a single repo input into { owner, repo }. Accepts:
 *   - owner/repo
 *   - https://github.com/owner/repo
 *   - github.com/owner/repo
 *   - ...with trailing .git and/or trailing slashes
 */
function parseRepo(input: string): { owner: string; repo: string } | null {
  const clean = input
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = clean.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function safeTimezone(tz: string | null): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function dayRangeLabel(days: string[]): string {
  if (days.length === 0) return "";
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const first = fmt.format(new Date(`${days[0]}T00:00:00Z`));
  if (days.length === 1) return first;
  const last = fmt.format(new Date(`${days[days.length - 1]}T00:00:00Z`));
  return `${first} – ${last}`;
}

/** Fetch all signals for one repo. Returns merged arrays; partial failures
 *  return whatever succeeded and push a warning. Fatal errors (404/rate-limit)
 *  throw so the caller can decide. */
async function fetchRepoActivity(
  owner: string,
  repo: string,
  token: string,
  warnings: string[]
): Promise<{
  prs: PullRequest[];
  issues: Issue[];
  commits: Commit[];
  reviews: Review[];
}> {
  const fullName = `${owner}/${repo}`;
  const [prsR, issuesR, commitsR] = await Promise.allSettled([
    fetchPRs(owner, repo, token),
    fetchIssues(owner, repo, token),
    fetchCommits(owner, repo, token),
  ]);

  if (prsR.status === "rejected") warnings.push(`PRs fetch failed for ${fullName}.`);
  if (issuesR.status === "rejected") warnings.push(`Issues fetch failed for ${fullName}.`);
  if (commitsR.status === "rejected") warnings.push(`Commits fetch failed for ${fullName}.`);

  // A fatal error on any primary fetch for this repo — surface clearly.
  const fatal = [prsR, issuesR, commitsR].find(
    (r): r is PromiseRejectedResult =>
      r.status === "rejected" &&
      /Repo not found|Rate limited|GitHub API error/.test(
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      )
  );
  if (fatal) {
    const msg = fatal.reason instanceof Error ? fatal.reason.message : "GitHub error";
    // Prefix with the repo so multi-repo failures are attributable.
    throw new Error(`${fullName}: ${msg}`);
  }

  const prs = prsR.status === "fulfilled" ? prsR.value : [];
  const issues = issuesR.status === "fulfilled" ? issuesR.value : [];
  const commits = commitsR.status === "fulfilled" ? commitsR.value : [];

  let reviews: Review[] = [];
  if (prs.length > 0) {
    try {
      reviews = await fetchReviews(owner, repo, prs, token);
    } catch {
      warnings.push(`Reviews fetch failed for ${fullName}.`);
    }
  }

  return { prs, issues, commits, reviews };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const reposParam = searchParams.get("repos") ?? searchParams.get("repo");
  const tz = safeTimezone(searchParams.get("tz"));

  const session = await getSession();
  if (!session.accessToken) {
    return NextResponse.json(
      { error: "Sign in with GitHub to use GitStandup." },
      { status: 401 }
    );
  }
  const token = session.accessToken;

  if (!reposParam) {
    return NextResponse.json(
      { error: "Missing 'repos' parameter." },
      { status: 400 }
    );
  }

  // Parse comma-separated repo list, dedupe, cap at MAX_REPOS.
  const parsedRepos = Array.from(
    new Set(
      reposParam
        .split(",")
        .map((r) => parseRepo(r))
        .filter((r): r is { owner: string; repo: string } => r !== null)
        .map((r) => ({ owner: r.owner.toLowerCase(), repo: r.repo }))
    )
  );

  if (parsedRepos.length === 0) {
    return NextResponse.json(
      { error: "Invalid repo format. Use owner/repo or a github.com URL." },
      { status: 400 }
    );
  }

  const tooMany = parsedRepos.length > MAX_REPOS;
  const reposToFetch = parsedRepos.slice(0, MAX_REPOS);
  const warnings: string[] = [];
  if (tooMany) {
    warnings.push(`Only the first ${MAX_REPOS} repos are processed (you selected ${parsedRepos.length}).`);
  }

  try {
    // Fetch each repo's activity in parallel. allSettled so one repo failing
    // (e.g. 404 / no access) doesn't kill the whole standup — we still show
    // whatever other repos returned.
    const results = await Promise.allSettled(
      reposToFetch.map((r) => fetchRepoActivity(r.owner, r.repo, token, warnings))
    );

    // Collect fatal per-repo errors into warnings (non-blocking) so the user
    // sees which repos failed but still gets a standup from the rest.
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        warnings.push(reason);
      }
    }

    // Merge all repo activity.
    const allPrs: PullRequest[] = [];
    const allIssues: Issue[] = [];
    const allCommits: Commit[] = [];
    const allReviews: Review[] = [];
    const successfulRepos: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        const { owner, repo } = reposToFetch[i];
        successfulRepos.push(`${owner}/${repo}`);
        allPrs.push(...r.value.prs);
        allIssues.push(...r.value.issues);
        allCommits.push(...r.value.commits);
        allReviews.push(...r.value.reviews);
      }
    }

    // If EVERY repo failed fatally, surface a top-level error.
    if (successfulRepos.length === 0) {
      const fatalMsg = warnings.find((w) => /Repo not found|Rate limited/.test(w));
      if (fatalMsg) {
        const status = fatalMsg.includes("not found") ? 404 : 429;
        return NextResponse.json({ error: fatalMsg }, { status });
      }
      return NextResponse.json(
        { error: "Could not fetch any of the selected repos." },
        { status: 502 }
      );
    }

    const grouped = groupByAuthor(
      { prs: allPrs, issues: allIssues, commits: allCommits, reviews: allReviews },
      tz
    );

    if (grouped.byAuthor.size === 0) {
      return NextResponse.json({
        repo: successfulRepos.join(", "),
        repos: successfulRepos,
        standups: [],
        days: [],
        dateRange: "",
        windowDays: grouped.windowDays,
        timezone: tz ?? "UTC",
        stats: {
          contributors: 0,
          prs: allPrs.length,
          issues: allIssues.length,
          commits: allCommits.length,
          reviews: allReviews.length,
        } satisfies StatsResponse,
        warnings,
        message: `No activity detected in the last ${grouped.windowDays} days across the selected repos.`,
      });
    }

    const inputs = Array.from(grouped.byAuthor.entries()).map(([login, activity]) => {
      const byDay: Record<string, DayActivityInput> = {};
      for (const [dayKey, day] of Object.entries(activity.byDay)) {
        byDay[dayKey] = {
          prs: day.prs.map((p) => ({ repo: p.repo, title: p.title, state: p.state })),
          issues: day.issues.map((i) => ({ repo: i.repo, title: i.title, state: i.state })),
          commits: day.commits.map((c) => ({ repo: c.repo, message: c.message, files: c.files })),
          reviews: day.reviews.map((r) => ({ repo: r.repo, prTitle: r.prTitle, state: r.state })),
        };
      }
      return { login, windowDays: grouped.windowDays, byDay };
    });

    const standups = await generateStandups(inputs);

    // Attach avatar_url from the author's activity.
    const byLogin = new Map<string, string>();
    for (const [, activity] of grouped.byAuthor) {
      if (activity.author.avatar_url && !byLogin.has(activity.author.login.toLowerCase())) {
        byLogin.set(activity.author.login.toLowerCase(), activity.author.avatar_url);
      }
    }

    const byDayByLogin = new Map<string, Record<string, DayActivityInput>>();
    for (const [login, activity] of grouped.byAuthor) {
      const byDay: Record<string, DayActivityInput> = {};
      for (const [dayKey, day] of Object.entries(activity.byDay)) {
        byDay[dayKey] = {
          prs: day.prs.map((p) => ({ repo: p.repo, title: p.title, state: p.state })),
          issues: day.issues.map((i) => ({ repo: i.repo, title: i.title, state: i.state })),
          commits: day.commits.map((c) => ({ repo: c.repo, message: c.message, files: c.files })),
          reviews: day.reviews.map((r) => ({ repo: r.repo, prTitle: r.prTitle, state: r.state })),
        };
      }
      byDayByLogin.set(login, byDay);
    }

    const responseStandups: StandupResponse[] = standups.map((s) => ({
      login: s.login,
      avatar_url: byLogin.get(s.login.toLowerCase()) ?? "",
      summary: s.summary,
      dailySummaries: s.dailySummaries ?? {},
      byDay: byDayByLogin.get(s.login) ?? {},
    }));

    return NextResponse.json({
      repo: successfulRepos.length === 1 ? successfulRepos[0] : successfulRepos.join(", "),
      repos: successfulRepos,
      standups: responseStandups,
      days: grouped.days,
      dateRange: dayRangeLabel(grouped.days),
      windowDays: grouped.windowDays,
      timezone: tz ?? "UTC",
      stats: {
        contributors: grouped.byAuthor.size,
        prs: allPrs.length,
        issues: allIssues.length,
        commits: allCommits.length,
        reviews: allReviews.length,
      } satisfies StatsResponse,
      warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
