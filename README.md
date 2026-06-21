# GitStandup

Daily standup bot powered by git. Enter a GitHub repo → get per-person summaries of what shipped, what's in progress, and what needs attention.

## How it works

GitStandup pulls every signal from the repo — PRs, issues, commits, reviews — aggregates per author, and uses AI to produce a clean standup. 

It works no matter how your team uses git:
- PR-based teams → rich summaries from PR titles + reviews
- Direct-to-main teams → infers context from commit messages + file paths
- Mixed teams → PRs provide structure, commits fill gaps
- Quiet repos → honest "no activity detected"
- Private repos → supported via GitHub sign-in (OAuth scope `repo`)

## Prerequisites

You'll need a **GitHub OAuth App**:
1. Go to https://github.com/settings/developers → **New OAuth App**.
2. **Homepage URL:** `https://your-domain`
3. **Authorization callback URL:** `https://your-domain/api/auth/callback`
4. Save the **Client ID** and generate a **Client Secret**.

## Running locally

```bash
cp .env.example .env   # or .env.local
# Fill in the values (see .env.example). For local dev, set:
#   OAUTH_REDIRECT_URL=http://localhost:3000/api/auth/callback
#   APP_BASE_URL=http://localhost:3000
# and add that callback URL to your OAuth App.
npm install
npm run dev
```

Open http://localhost:3000, sign in with GitHub, then paste a repo (e.g.
`facebook/react`, or one of your private repos).

> Login is required. The OAuth access token is stored in an encrypted
> HTTP-only cookie (iron-session) and used server-side only — it never
> reaches the browser. This unlocks private repos and GitHub's 5,000 req/hr
> authenticated rate limit.

## What I built and why

### The problem
Daily standups are useful but writing them is tedious. Most teams either skip them or write fiction. Meanwhile, git already has the full picture of what everyone did — but it's scattered across commits, PRs, issues, and reviews. Nobody reads all of that in the morning.

### Who's it for
Engineering teams of any size. Especially teams where not everyone follows the same git workflow — some use PRs, some commit to main, some squash everything.

### Why not existing tools
- Linear/Jira standups depend on people actually updating tickets (they don't)
- Git history alone is noisy — "fix stuff" doesn't mean anything
- Existing AI standup tools assume PR-based workflow and break on direct-to-main repos

GitStandup pulls ALL signals and lets the AI figure out what's meaningful.

### What's in scope
- Public **and private** repos (via GitHub OAuth, scope `repo`)
- GitHub sign-in required to use the app
- Per-author standup generation from PRs + issues + commits + reviews
- Clean web UI with copy-to-clipboard
- Graceful handling of empty repos, rate limits, repos you can't access

### What's out of scope (and why)
- Custom GitHub App with fine-grained per-repo permissions — OAuth `repo` scope is simpler and sufficient for v1
- Slack/Discord integration — shipping a working web app first
- Multi-day trends — focused on "what happened in last 24h"
- Team analytics/metrics — scope creep
- Custom date ranges — keep it simple, daily standup is the default

### Assumptions I made
- GitHub's authenticated rate limit (5,000 req/hr) is comfortable for personal/team use.
- A fast, cheap summarization model is good enough for standups. A larger model would be better for very technical repos.
- All-git workflow — if a team uses something external (Notion, Google Docs) for task tracking, we can't see it and the standup will be sparser.
- Activity = merged/closed PRs and issues + commits. Opened-but-stale PRs are excluded.

### Three questions I'd ask a real user
1. "What do you actually say in your standup that git can't capture?" (mentoring, meetings, research spikes)
2. "Do you want to see per-person or per-project summaries?" (some teams prefer grouped by feature)
3. "Would you want to edit the AI summary before sharing it?" (confidence check before broadcasting)

### How I'd know it's working
- Users actually use it daily (return rate)
- Generated standups match what team members would say in a real standup (spot-check accuracy)
- One team member per 10 that says "I'd change this line" vs "this is completely wrong"
- Time saved: 5 min per person per day × team size

### What I'd do next
1. Fine-grained GitHub App for per-repo read-only permissions (safer than broad `repo` scope)
2. Slack/Discord webhook to auto-post standup
3. Custom prompts per team ("we focus on blockers, not task lists")
4. "What I did yesterday" vs "What I'm doing today" split
5. Multi-repo support for teams with monorepo setups

## Deployment (Dokploy / Docker)

The repo includes a multi-stage `Dockerfile` that builds Next.js in
`output: "standalone"` mode and runs as a non-root user on port `3000`.

1. Create the GitHub OAuth App as described in **Prerequisites** above, using
   your production domain.
2. In Dokploy, create a **Docker app** pointing at this repo. The `Dockerfile`
   builds automatically.
3. Expose port `3000`; let Dokploy's proxy terminate TLS.
4. Set the environment variables (see `.env.example`) in Dokploy's env panel:
   `SUMPOD_API_KEY`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `OAUTH_REDIRECT_URL`, `APP_BASE_URL`, `SESSION_SECRET`.
5. Deploy, visit the URL, sign in with GitHub.

> Generate `SESSION_SECRET` with `openssl rand -hex 32`.

## How I used AI

### Where AI helped
- **Core summarization**: the model turns messy commit messages, PR titles, and file paths into readable English. This is the product — no way to build it without AI.
- **UI scaffolding**: AI-generated layout and styling, saving time on CSS work.
- **README draft**: AI helped structure the first draft, which I then heavily edited for accuracy and voice.

### Where AI got it wrong (and I caught it)
- **Over-summarization**: For repos with very technical commits ("refactor OAuth2 PKCE flow in auth-service"), the model would sometimes strip out the technical detail and say "working on auth." I had to tune the prompt to preserve specificity.
- **False blockers**: The AI flagged "fix typo" and "revert" commits as potential blockers. I added a filter — only flag commits mentioning TODO, HACK, FIXME, or containing error messages.
- **Invented detail**: On one test repo, the AI confidently claimed someone "reviewed 3 PRs" when they had only reviewed 1. The issue was that GitHub's API returns review comments as separate events. I deduplicated by PR number.
- **File path hallucination**: The AI would sometimes invent file paths that didn't exist ("src/components/Auth.tsx" when the actual file was "src/auth/login.ts"). Fixed by passing actual file paths from the GitHub API as structured data, not letting the AI guess.
