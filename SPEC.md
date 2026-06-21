# GitStandup — Build Specification

Daily standup generator from git history. PRs, commits, issues, reviews → per-person AI summaries.

**Target:** Ship in 48 hours. **Stack:** Next.js 16 (App Router), TypeScript, Tailwind CSS 4. **AI:** Sumopod (`deepseek-v4-flash` via OpenAI-compatible API). **Deploy:** Vercel.

---

## 1. Architecture Overview

```
Browser                          Next.js Server                    External APIs
───────                          ──────────────                    ─────────────
                                                                   
[Homepage] ──GET /api/standup──→ [API Route] ──parallel fetch──→ GitHub REST API
    │        (sign in w/ GitHub)   │    │    │                     (OAuth token, scope: repo)
    │                               │    │    └── /repos/{o}/{r}/commits
    │                               │    ├─────── /repos/{o}/{r}/issues
    │                               │    └─────── /repos/{o}/{r}/pulls
    │                               │              └── /repos/{o}/{r}/pulls/{n}/reviews
    │                               │
    │                               ├── groupByAuthor()
    │                               │
    │                               └── generateStandups() ────→ Sumopod API
    │                                    (Parallel AI calls)       deepseek-v4-flash
    │
    ├── JSON response
    │
[Standup Cards] ←────────────────┘

Login is required. The OAuth access token (scope `repo`) is stored in an
encrypted HTTP-only cookie via iron-session and passed server-side to every
GitHub fetch. This unlocks private repos and raises the rate limit to
5,000 req/hr per user.
```

## 2. File Structure

```
gitstandup/
├── Dockerfile            # Multi-stage Next.js standalone image (Dokploy)
├── .dockerignore
├── .env.local            # Secrets — see §9 (do not commit)
├── .env.example          # Template
├── README.md
├── SPEC.md               # This file
├── package.json
├── tsconfig.json
├── next.config.ts        # output: "standalone"
├── src/
│   ├── app/
│   │   ├── layout.tsx      # Root layout (metadata + children)
│   │   ├── page.tsx        # Homepage UI (login wall + standup cards)
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── login/route.ts     # → GitHub authorize
│   │       │   ├── callback/route.ts  # code → token → session
│   │       │   ├── logout/route.ts    # destroy session
│   │       │   └── me/route.ts        # current user identity
│   │       └── standup/
│   │           └── route.ts  # API handler (session required)
│   └── lib/
│       ├── session.ts     # iron-session wrapper
│       ├── github.ts      # GitHub API client (token-authed)
│       └── ai.ts          # Sumopod/OpenAI client
```

---

## 3. Implementation Order (Follow Strictly)

### Step 1: `lib/github.ts` — GitHub API Client

#### 3.1.1 `githubFetch(path, token): Promise<any>`
Helper for all GitHub API calls. DO NOT duplicate fetch logic. Login is
required, so `token` is mandatory on every fetch (OAuth scope `repo`).

```typescript
const GITHUB_API = "https://api.github.com";

async function githubFetch(path: string, token: string): Promise<any> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Authorization": `Bearer ${token}`,
    },
  });
  
  if (res.status === 404) throw new Error("Repo not found or no access");
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining === "0" && reset) {
      throw new Error(`Rate limited. Resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}`);
    }
    throw new Error("GitHub API error: 403 (access denied)");
  }
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  
  return res.json();
}
```

All fetchers (`fetchPRs`, `fetchIssues`, `fetchCommits`, `fetchReviews`)
take `token` as a trailing required argument and forward it to `githubFetch`.
`fetchAuthenticatedUser(token)` wraps `GET /user` for the OAuth callback.

#### 3.1.2 `fetchPRs(owner, repo): Promise<PullRequest[]>`
- Endpoint: `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`
- Filter: keep PRs where `updated_at` or `created_at` is within last 24 hours
- Return only: `{ number, title, state, user: { login, avatar_url } }`
- `state` from GitHub is "open" or "closed". For closed PRs, check `merged_at` — if non-null, state is effectively "merged". Leave as "closed" if `merged_at` is null.

#### 3.1.3 `fetchIssues(owner, repo): Promise<Issue[]>`
- Endpoint: `GET /repos/{owner}/{repo}/issues?state=all&since={ISO 24h ago}&per_page=30`
- **Critical:** GitHub's issues endpoint ALSO returns pull requests. Filter them out:
  ```typescript
  issues.filter(issue => !issue.pull_request)
  ```
- Return only: `{ number, title, state, user, assignees }`

#### 3.1.4 `fetchCommits(owner, repo): Promise<Commit[]>`
- Endpoint: `GET /repos/{owner}/{repo}/commits?since={ISO 24h ago}&per_page=20`
- Each commit already includes: `sha`, `commit.message`, `author` (from `commit.author` or `author`)
- For file paths: DO NOT fetch per-commit details (rate limit risk). Instead, the commit response includes `.files` sometimes — check for it. If absent, file paths will be empty — that's fine, the AI prompt handles missing file data gracefully.
- Return: `{ sha, message, files: string[], author: { login, avatar_url } | null }`
- **Handle null author:** Some commits have no GitHub user (detached HEAD, deleted accounts). Set `author` to `null` — `groupByAuthor` will bucket them under "unknown".

#### 3.1.5 `fetchReviews(owner, repo, prs): Promise<Review[]>`
- Only fetch reviews for closed/merged PRs (open PR reviews are in-progress and noisy).
- Endpoint per PR: `GET /repos/{owner}/{repo}/pulls/{pr_number}/reviews`
- **Skip self-reviews:** If `review.user.login === pr.user.login`, skip it.
- Return: `{ prTitle, prNumber, reviewer: { login, avatar_url }, state }` where state is "APPROVED", "CHANGES_REQUESTED", or "COMMENTED".
- **Rate limit safety:** If there are more than 5 closed PRs, only fetch reviews for the first 5 (sorted by most recent). At 1 request per PR, this keeps us under GitHub's 60/hr limit.

#### 3.1.6 `groupByAuthor({ prs, issues, commits, reviews }): Map<string, AuthorActivity>`
- Create a `Map<string, AuthorActivity>` keyed by `login.toLowerCase()` (normalize case).
- For each PR: add to `author.prs[]`. Use `pr.user.login` as key. If `pr.user` is null, key = "unknown".
- For each issue: add to `author.issues[]`. If issue has `assignees`, add to those authors too (counts as involvement).
- For each commit: add to `author.commits[]`. Use `commit.author.login` as key. Null author → "unknown".
- For each review: add to `author.reviews[]`. Use `review.reviewer.login` as key.
- **Skip empty authors:** After grouping, remove any author entries where ALL arrays are empty.
- Return the Map.

### Step 2: `lib/ai.ts` — AI Summarization

Already scaffolded with Sumopod config. Implement the TODOs:

#### 3.2.1 `buildPrompt(input: StandupInput): string`
Build a structured user prompt. Format:

```
Developer: {login}

Pull Requests:
- [merged] Fix login redirect bug
- [open] Add vendor registration form
(None if empty)

Issues:
- [closed] Dashboard analytics broken on Safari
(None if empty)

Commits:
- fix: resolve token refresh race condition (src/auth/)
- wip: start on payment integration (src/billing/)
(None if empty)

Reviews:
- [APPROVED] Add vendor registration form
(None if empty)
```

Rules for formatting:
- PR state: "merged" if `merged_at` is non-null, otherwise "open" or "closed"
- Issue state: "open" or "closed"
- Commits: show first line of message + file paths in parentheses (first 3 files max, truncate with "...")
- Reviews: show state + PR title
- Empty sections → "(None)"

#### 3.2.2 `generateStandup(input: StandupInput): Promise<StandupOutput>`
```typescript
export async function generateStandup(input: StandupInput): Promise<StandupOutput> {
  const userPrompt = buildPrompt(input);
  
  const completion = await openai.chat.completions.create({
    model: MODEL, // "deepseek-v4-flash"
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 150,
  });
  
  const summary = completion.choices[0]?.message?.content?.trim() || "No summary generated";
  
  return { login: input.login, summary };
}
```

Error handling:
- If Sumopod returns an error → return `{ login, summary: "AI unavailable — showing raw data" }` and include raw PR/commit count in the summary
- NEVER crash the entire request because one author's AI call failed

#### 3.2.3 `generateStandups(activities): Promise<StandupOutput[]>`
```typescript
export async function generateStandups(activities: StandupInput[]): Promise<StandupOutput[]> {
  // Run all in parallel, but handle individual failures
  const results = await Promise.allSettled(
    activities.map(a => generateStandup(a))
  );
  
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { login: activities[i].login, summary: "Failed to generate summary" };
  });
}
```
Use `Promise.allSettled`, NOT `Promise.all` — one failure shouldn't kill all others.

### Step 3: `app/api/standup/route.ts` — API Handler

#### 3.3.1 Input parsing
Parse `repo` from query string. Accept formats:
- `owner/repo` (e.g., `facebook/react`)
- `github.com/owner/repo` (e.g., `https://github.com/facebook/react`)
- `github.com/owner/repo.git`
- Trailing slashes on all of the above

```typescript
function parseRepo(input: string): { owner: string; repo: string } | null {
  // Strip protocol, trailing .git, trailing slashes
  let clean = input.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const parts = clean.split("/");
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}
```

#### 3.3.2 Data fetching (with partial failure tolerance)
```typescript
// Fetch primary signals in parallel
const [prsResult, issuesResult, commitsResult] = await Promise.allSettled([
  fetchPRs(owner, repo),
  fetchIssues(owner, repo),
  fetchCommits(owner, repo),
]);

const prs = prsResult.status === "fulfilled" ? prsResult.value : [];
const issues = issuesResult.status === "fulfilled" ? issuesResult.value : [];
const commits = commitsResult.status === "fulfilled" ? commitsResult.value : [];

// Fetch reviews (depends on PRs)
let reviews: Review[] = [];
if (prs.length > 0) {
  try {
    reviews = await fetchReviews(owner, repo, prs);
  } catch {
    // Reviews failing is non-critical — continue without them
  }
}
```

**Rationale:** If one GitHub endpoint fails (rate limit, partial outage), don't kill the entire standup. Show what's available.

#### 3.3.3 Group and generate
```typescript
const grouped = groupByAuthor({ prs, issues, commits, reviews });

const inputs: StandupInput[] = Array.from(grouped.entries()).map(([login, activity]) => ({
  login,
  prs: activity.prs.map(p => ({ title: p.title, state: p.state })),
  issues: activity.issues.map(i => ({ title: i.title, state: i.state })),
  commits: activity.commits.map(c => ({ message: c.message, files: c.files })),
  reviews: activity.reviews.map(r => ({ prTitle: r.prTitle, state: r.state })),
}));

const standups = await generateStandups(inputs);
```

#### 3.3.4 Response format
```json
{
  "repo": "facebook/react",
  "standups": [
    {
      "login": "gaearon",
      "avatar_url": "https://avatars.githubusercontent.com/u/...",
      "summary": "Merged 2 PRs including a fix for the context propagation bug..."
    }
  ],
  "stats": {
    "contributors": 5,
    "prs": 12,
    "issues": 3,
    "commits": 27,
    "reviews": 8
  },
  "warnings": ["Issues fetch failed — showing partial data"]
}
```

Include `avatar_url` in the response — the frontend needs it for the cards. Pull it from the first activity where the author appears (PR user, commit author, or issue assignee).

### Step 4: `app/page.tsx` — Frontend

Already scaffolded with UI. Implement the two TODOs:

#### 3.4.1 `handleGenerate()`
```typescript
async function handleGenerate() {
  if (!repo.trim()) return;
  
  setLoading(true);
  setError("");
  setStandups([]);
  
  try {
    const res = await fetch(`/api/standup?repo=${encodeURIComponent(repo.trim())}`);
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error || "Failed to generate standup");
    
    setStandups(data.standups);
    setStats(data.stats);
    if (data.warnings?.length) {
      setError(data.warnings.join(". "));
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : "Something went wrong");
  } finally {
    setLoading(false);
  }
}
```

#### 3.4.2 `handleCopyAll()`
```typescript
function handleCopyAll() {
  const text = standups.map(s => `**${s.login}**\n${s.summary}`).join("\n\n");
  navigator.clipboard.writeText(text);
  // Optional: show a brief "Copied!" toast
}
```

### Step 5: `layout.tsx` — Metadata
```typescript
export const metadata = {
  title: "GitStandup — Daily standup from git history",
  description: "Generate per-person standup summaries from GitHub PRs, commits, issues, and reviews.",
};
```

---

## 4. Error Handling Matrix

| Scenario | User sees |
|----------|-----------|
| Repo not found | "Repo not found. Check the name and try again." |
| GitHub rate limited | "GitHub rate limit reached. Resets at {time}. Try again then or use a smaller repo." |
| Private / no-access repo | "Repo not found or no access" (GitHub returns 404 when the token lacks access). |
| Not signed in | "Sign in with GitHub to use GitStandup." (API returns 401; frontend shows the login wall.) |
| Empty repo / no activity | "No activity detected in the last 24 hours for this repo." |
| Sumopod API key missing | "AI summarization unavailable. Check SUMPOD_API_KEY in environment." |
| Sumopod returns garbage | "AI generated a summary but it may be low quality — showing raw data." (Still show the standup) |
| Partial GitHub failure | Show standup with available data + warning: "Issues fetch failed — showing partial data." |
| Network timeout | "Request timed out. The repo may be too large. Try a smaller one." |

---

## 5. Edge Cases

- **Author with null login:** Bucket under "unknown". The AI prompt should still work — just call them "Unknown contributor".
- **Repo with thousands of commits/day:** The `per_page` limits on API calls cap data volume. If a single author has 50+ commits, truncate to latest 20 in the prompt to avoid token overflow.
- **Same author appearing in PRs AND commits:** `groupByAuthor` naturally merges them. The AI gets richer data.
- **No activity at all (weekend repo):** Return `standups: []` with a message.
- **Commit messages in non-English (Bahasa Indonesia, Chinese):** The AI prompt is in English, but DeepSeek handles multilingual input. Don't translate — let the AI decide.
- **Extremely long PR titles / commit messages:** Truncate to 200 characters in the prompt to stay within token budget.

---

## 6. What NOT to Build

- ❌ GitHub OAuth **was originally out of scope, now implemented** — private repos are supported via OAuth (scope `repo`).
- ❌ Custom date range picker — stick to "last 24 hours" (simpler, reliable)
- ❌ Slack/Discord integration — web-first, integrations come later
- ❌ Persistent storage / database — stateless, fetch fresh every time
- ❌ Team analytics / trends — scope creep
- ❌ Streaming AI responses — non-streaming is simpler and sufficient for 150-token responses

---

## 7. Testing Checklist

Before submitting, verify:

- [ ] Paste `facebook/react` → shows standups (large repo, good test)
- [ ] Paste `mamenesia/muwakeel` → shows your own repo activity
- [ ] Paste a nonexistent repo → shows "Repo not found"
- [ ] Paste a private repo you have access to → shows standups (OAuth token scopes unlock it)
- [ ] Paste a private repo you DON'T have access to → shows "Repo not found or no access"
- [ ] Not signed in → app shows the login wall; /api/standup returns 401
- [ ] Repo with 0 commits in 24h → shows "No activity"
- [ ] Repo with only direct-to-main commits (no PRs) → shows commit-based standups
- [ ] Copy-to-clipboard works
- [ ] Mobile responsive (input + cards stack properly)
- [ ] Loading skeletons appear during fetch
- [ ] Refresh page → still works (no state corruption)
- [ ] Rate limit: works at least 3 times in a row without hitting GitHub limit

---

## 8. Deployment

Self-hosted on a VPS via Dokploy using the included Dockerfile (Next.js
standalone output).

### 8.1 Create the GitHub OAuth App
1. Go to https://github.com/settings/developers → **New OAuth App**.
2. **Homepage URL:** `https://your-domain`
3. **Authorization callback URL:** `https://your-domain/api/auth/callback`
4. Note the **Client ID**; generate a **Client Secret**.

### 8.2 Deploy on Dokploy
1. Push the repo to a Git remote Dokploy can reach.
2. In Dokploy, create a **Docker app** pointed at the repo. The `Dockerfile`
   builds a multi-stage standalone image (non-root user, listens on `:3000`).
3. Expose port `3000` and terminate TLS at Dokploy's proxy.
4. Set the environment variables from §9 in Dokploy's env panel.
5. Deploy, then visit the live URL and sign in with GitHub.

### 8.3 Local dev
```bash
cp .env.example .env   # or .env.local
# Fill in the values from §9. For local OAuth, set:
#   OAUTH_REDIRECT_URL=http://localhost:3000/api/auth/callback
#   APP_BASE_URL=http://localhost:3000
# and add http://localhost:3000/api/auth/callback to your OAuth App's
# callback URLs.
npm install
npm run dev
```

---

## 9. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUMPOD_API_KEY` | Yes | Sumopod API key for AI summarization |
| `GITHUB_OAUTH_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | Yes | GitHub OAuth App client secret (server-side only) |
| `OAUTH_REDIRECT_URL` | Yes | Must match the OAuth App callback URL: `…/api/auth/callback` |
| `APP_BASE_URL` | Yes | Base URL of the deployment (used for post-login/logout redirects) |
| `SESSION_SECRET` | Yes | ≥32 random chars for iron-session cookie encryption (`openssl rand -hex 32`) |

### Security notes
- `GITHUB_OAUTH_CLIENT_SECRET` and `SESSION_SECRET` are server-side only and
  must never be shipped to the browser or committed to the repo.
- The OAuth token is stored encrypted in an HTTP-only cookie, never in
  localStorage or a URL.
- `SESSION_SECRET` rotation invalidates all active sessions.
