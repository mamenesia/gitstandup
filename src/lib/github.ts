const GITHUB_API = "https://api.github.com";

// Window length in days, configurable via env. Default 7 (weekly).
const WINDOW_DAYS = Math.max(
  1,
  Number(process.env.STANDUP_WINDOW_DAYS) || 7
);
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface GitHubAuthor {
  login: string;
  avatar_url: string;
}

export interface PullRequest {
  repo: string; // "owner/repo"
  title: string;
  state: string; // "open" | "closed" | "merged"
  number: number;
  user: GitHubAuthor | null;
  date: string; // ISO timestamp used for day bucketing
}

export interface Issue {
  repo: string;
  title: string;
  state: string; // "open" | "closed"
  number: number;
  user: GitHubAuthor | null;
  assignees: GitHubAuthor[];
  date: string;
}

export interface Commit {
  repo: string;
  sha: string;
  message: string;
  files: string[];
  author: GitHubAuthor | null;
  date: string;
}

export interface Review {
  repo: string;
  prTitle: string;
  prNumber: number;
  reviewer: GitHubAuthor;
  state: string; // "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
  date: string;
}

export interface AuthorActivity {
  author: GitHubAuthor;
  prs: PullRequest[];
  issues: Issue[];
  commits: Commit[];
  reviews: Review[];
}

/** Activity bucketed by day key (YYYY-MM-DD) in the viewer's timezone. */
export type DayBucketed = Record<string, AuthorActivity>;

export interface GroupedActivities {
  byAuthor: Map<string, AuthorActivity & { byDay: DayBucketed }>;
  days: string[]; // sorted ascending list of day keys that have activity
  windowDays: number;
}

interface RawRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  updated_at: string;
  description: string | null;
}

export interface UserRepo {
  fullName: string; // "owner/repo"
  name: string;
  owner: string;
  private: boolean;
  updatedAt: string;
  description: string | null;
}

/**
 * List the signed-in user's repos (public + private they have access to).
 * Capped at 100 (one page) for v1 — sufficient for personal/team use.
 */
export async function fetchUserRepos(token: string): Promise<UserRepo[]> {
  const raw = await githubFetch<RawRepo[]>(
    "/user/repos?per_page=100&sort=updated&direction=desc",
    token
  );
  return raw.map((r) => ({
    fullName: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? "",
    private: r.private,
    updatedAt: r.updated_at,
    description: r.description,
  }));
}

// ---- Raw GitHub response shapes (only the fields we read) -----
interface RawUser {
  login: string;
  avatar_url: string;
}
interface RawPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  updated_at: string;
  created_at: string;
  user: RawUser | null;
}
interface RawAssignee {
  login: string;
  avatar_url: string;
}
interface RawIssue {
  number: number;
  title: string;
  state: string;
  user: RawUser | null;
  assignees: RawAssignee[];
  updated_at: string;
  closed_at: string | null;
  created_at: string;
  pull_request?: unknown;
}
interface RawFile {
  filename: string;
}
interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author?: { date?: string };
    committer?: { date?: string };
  };
  author: RawUser | null;
  files?: RawFile[];
}
interface RawReview {
  state: string;
  user: RawUser | null;
  submitted_at: string | null;
}

/**
 * Helper for all GitHub API calls. Do not duplicate fetch logic elsewhere.
 * Login is required, so `token` is mandatory on every fetch.
 */
async function githubFetch<T = unknown>(
  path: string,
  token: string
): Promise<T> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 404) throw new Error("Repo not found or no access");
  if (res.status === 403) {
    const reset = res.headers.get("x-ratelimit-reset");
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" && reset) {
      const resetDate = new Date(Number(reset) * 1000);
      throw new Error(
        `Rate limited. Resets at ${resetDate.toLocaleTimeString()}`
      );
    }
    throw new Error("GitHub API error: 403 (access denied)");
  }
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

  return res.json();
}

function sinceISO(): string {
  return new Date(Date.now() - WINDOW_MS).toISOString();
}

/**
 * Fetch PRs updated in the window. `state` from GitHub is "open"/"closed";
 * closed PRs with a non-null `merged_at` are reported as "merged".
 * Day-bucket date = merged_at if merged, else updated_at.
 */
export async function fetchPRs(
  owner: string,
  repo: string,
  token: string
): Promise<PullRequest[]> {
  const path = `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const raw = await githubFetch<RawPull[]>(path, token);

  const cutoff = Date.now() - WINDOW_MS;
  return raw
    .filter((pr) => new Date(pr.updated_at || pr.created_at).getTime() >= cutoff)
    .map((pr) => ({
      repo: `${owner}/${repo}`,
      number: pr.number,
      title: pr.title,
      state:
        pr.merged_at != null
          ? "merged"
          : pr.state === "open"
            ? "open"
            : "closed",
      user: pr.user
        ? { login: pr.user.login, avatar_url: pr.user.avatar_url }
        : null,
      date: pr.merged_at ?? pr.updated_at,
    }));
}

/**
 * Fetch issues updated in the window. GitHub's issues endpoint ALSO returns
 * PRs — filter those out via the `pull_request` key.
 * Day-bucket date = closed_at if closed, else updated_at.
 */
export async function fetchIssues(
  owner: string,
  repo: string,
  token: string
): Promise<Issue[]> {
  const since = sinceISO();
  const path = `/repos/${owner}/${repo}/issues?state=all&since=${since}&per_page=100`;
  const raw = await githubFetch<RawIssue[]>(path, token);

  return raw
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      repo: `${owner}/${repo}`,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      user: issue.user
        ? { login: issue.user.login, avatar_url: issue.user.avatar_url }
        : null,
      assignees: Array.isArray(issue.assignees)
        ? issue.assignees
            .filter((a) => Boolean(a && a.login))
            .map((a) => ({ login: a.login, avatar_url: a.avatar_url }))
        : [],
      date: issue.closed_at ?? issue.updated_at,
    }));
}

/**
 * Fetch commits since the window start. The list endpoint occasionally
 * includes `.files`; if absent, `files` is empty. Day-bucket date =
 * commit.author.date (when work was done), falling back to committer date.
 */
export async function fetchCommits(
  owner: string,
  repo: string,
  token: string
): Promise<Commit[]> {
  const since = sinceISO();
  const path = `/repos/${owner}/${repo}/commits?since=${since}&per_page=100`;
  const raw = await githubFetch<RawCommit[]>(path, token);

  return raw.map((c) => {
    const ghAuthor = c.author;
    const author =
      ghAuthor && ghAuthor.login
        ? { login: ghAuthor.login, avatar_url: ghAuthor.avatar_url }
        : null;

    const files: string[] = Array.isArray(c.files)
      ? c.files.map((f) => f.filename).filter(Boolean)
      : [];

    const date =
      c.commit?.author?.date ?? c.commit?.committer?.date ?? "";

    return {
      repo: `${owner}/${repo}`,
      sha: c.sha,
      message: c.commit?.message ?? "",
      files,
      author,
      date,
    };
  });
}

/**
 * Fetch reviews for closed/merged PRs. Self-reviews are skipped.
 * Rate-limit safety: only the 10 most recent closed PRs are queried.
 * Day-bucket date = submitted_at.
 */
export async function fetchReviews(
  owner: string,
  repo: string,
  prs: PullRequest[],
  token: string
): Promise<Review[]> {
  const closedPrs = prs
    .filter((pr) => pr.state === "closed" || pr.state === "merged")
    .slice(0, 10);

  const results = await Promise.allSettled(
    closedPrs.map((pr) =>
      githubFetch<RawReview[]>(
        `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`,
        token
      ).then((reviews) => ({ pr, reviews: Array.isArray(reviews) ? reviews : [] }))
    )
  );

  const out: Review[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { pr, reviews } = r.value;
    for (const rv of reviews) {
      const reviewer = rv.user;
      if (!reviewer || !reviewer.login) continue;
      if (pr.user && reviewer.login === pr.user.login) continue;
      if (!rv.submitted_at) continue;

      const state =
        rv.state === "APPROVED" ||
        rv.state === "CHANGES_REQUESTED" ||
        rv.state === "COMMENTED"
          ? rv.state
          : "COMMENTED";

      out.push({
        repo: `${owner}/${repo}`,
        prTitle: pr.title,
        prNumber: pr.number,
        reviewer: {
          login: reviewer.login,
          avatar_url: reviewer.avatar_url,
        },
        state,
        date: rv.submitted_at,
      });
    }
  }
  return out;
}

export async function fetchAuthenticatedUser(
  token: string
): Promise<GitHubAuthor> {
  const raw = await githubFetch<RawUser>("/user", token);
  return { login: raw.login, avatar_url: raw.avatar_url };
}

const UNKNOWN_KEY = "unknown";
const UNKNOWN_AUTHOR: GitHubAuthor = {
  login: "unknown",
  avatar_url: "",
};

/**
 * Convert an ISO timestamp to a YYYY-MM-DD day key in the given IANA timezone.
 * Falls back to UTC if tz is missing/invalid. Returns "" for empty input.
 */
export function groupDateKey(iso: string, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const day = parts.find((p) => p.type === "day")?.value ?? "";
    const key = `${y}-${m}-${day}`;
    return key.length === 10 ? key : "";
  } catch {
    // Invalid tz → fall back to UTC.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const day = parts.find((p) => p.type === "day")?.value ?? "";
    return `${y}-${m}-${day}`;
  }
}

/**
 * Group PRs, issues, commits, and reviews into per-author buckets keyed by
 * normalized login (lowercased). Each author also gets a `byDay` map keyed
 * by YYYY-MM-DD in the viewer's timezone. Null authors bucket under
 * "unknown". Issues also count toward each assignee. Authors with no
 * activity are removed.
 */
export function groupByAuthor(
  activities: {
    prs: PullRequest[];
    issues: Issue[];
    commits: Commit[];
    reviews: Review[];
  },
  tz?: string
): GroupedActivities {
  const map = new Map<
    string,
    AuthorActivity & { byDay: DayBucketed }
  >();
  const daySet = new Set<string>();

  const getOrCreate = (
    login: string,
    author: GitHubAuthor
  ): AuthorActivity & { byDay: DayBucketed } => {
    const key = login.toLowerCase();
    let entry = map.get(key);
    if (!entry) {
      entry = {
        author: author ?? UNKNOWN_AUTHOR,
        prs: [],
        issues: [],
        commits: [],
        reviews: [],
        byDay: {},
      };
      map.set(key, entry);
    }
    return entry;
  };

  const getOrCreateDay = (
    entry: AuthorActivity & { byDay: DayBucketed },
    dayKey: string
  ): AuthorActivity => {
    if (!entry.byDay[dayKey]) {
      entry.byDay[dayKey] = {
        author: entry.author,
        prs: [],
        issues: [],
        commits: [],
        reviews: [],
      };
    }
    return entry.byDay[dayKey];
  };

  for (const pr of activities.prs) {
    const login = pr.user?.login ?? UNKNOWN_KEY;
    const author = pr.user ?? UNKNOWN_AUTHOR;
    const entry = getOrCreate(login, author);
    entry.prs.push(pr);
    const dk = groupDateKey(pr.date, tz);
    if (dk) {
      daySet.add(dk);
      getOrCreateDay(entry, dk).prs.push(pr);
    }
  }

  for (const issue of activities.issues) {
    const login = issue.user?.login ?? UNKNOWN_KEY;
    const author = issue.user ?? UNKNOWN_AUTHOR;
    const entry = getOrCreate(login, author);
    entry.issues.push(issue);
    const dk = groupDateKey(issue.date, tz);
    if (dk) {
      daySet.add(dk);
      getOrCreateDay(entry, dk).issues.push(issue);
    }
    for (const assignee of issue.assignees) {
      if (assignee?.login) {
        const aEntry = getOrCreate(assignee.login, assignee);
        aEntry.issues.push(issue);
        if (dk) getOrCreateDay(aEntry, dk).issues.push(issue);
      }
    }
  }

  for (const commit of activities.commits) {
    const login = commit.author?.login ?? UNKNOWN_KEY;
    const author = commit.author ?? UNKNOWN_AUTHOR;
    const entry = getOrCreate(login, author);
    entry.commits.push(commit);
    const dk = groupDateKey(commit.date, tz);
    if (dk) {
      daySet.add(dk);
      getOrCreateDay(entry, dk).commits.push(commit);
    }
  }

  for (const review of activities.reviews) {
    const login = review.reviewer.login;
    const entry = getOrCreate(login, review.reviewer);
    entry.reviews.push(review);
    const dk = groupDateKey(review.date, tz);
    if (dk) {
      daySet.add(dk);
      getOrCreateDay(entry, dk).reviews.push(review);
    }
  }

  // Remove authors with no activity in any category.
  for (const [key, entry] of map) {
    if (
      entry.prs.length === 0 &&
      entry.issues.length === 0 &&
      entry.commits.length === 0 &&
      entry.reviews.length === 0
    ) {
      map.delete(key);
    }
  }

  const days = Array.from(daySet).sort();

  return { byAuthor: map, days, windowDays: WINDOW_DAYS };
}
