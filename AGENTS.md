# GitStandup — Project Context

Daily standup bot powered by git. PRs, commits, issues, reviews → per-person AI summaries.

## Stack
- Next.js 16 (App Router) with TypeScript
- Tailwind CSS 4
- GitHub REST API (no auth — public repos only)
- Sumopod (`deepseek-v4-flash`) via OpenAI-compatible API

## Key Commands
```bash
npm run dev      # Start dev server on localhost:3000
npm run build    # Production build
npm run lint     # ESLint
```

## Project Rules
- Read SPEC.md before implementing anything — it's the source of truth
- Implement in order: github.ts → ai.ts → route.ts → page.tsx
- All API calls go through `lib/github.ts` `githubFetch()` helper — never inline fetch
- Use `Promise.allSettled` for parallel API calls, never `Promise.all`
- Handle null authors, rate limits, and empty repos gracefully
- NEVER modify files outside the implementation step you're on
- Run `npm run build` after each file to catch type errors early
- `.env.local` must have `SUMPOD_API_KEY` set

## File Purposes
- `src/lib/github.ts` — GitHub API client (fetchPRs, fetchIssues, fetchCommits, fetchReviews, groupByAuthor)
- `src/lib/ai.ts` — Sumopod AI client (buildPrompt, generateStandup, generateStandups)
- `src/app/api/standup/route.ts` — API handler (parse repo, fetch data, group, generate, respond)
- `src/app/page.tsx` — Frontend UI (input, standup cards, loading states, copy)

## Style
- TypeScript — strict types on all public functions
- Error handling — every fetch wrapped, partial failures tolerated
- Naming — camelCase functions, PascalCase components
- No `any` types — use proper interfaces from lib/github.ts
