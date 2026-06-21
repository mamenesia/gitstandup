import OpenAI from "openai";

// Sumopod — OpenAI-compatible API gateway
// https://ai.sumopod.com
const openai = new OpenAI({
  apiKey: process.env.SUMPOD_API_KEY,
  baseURL: "https://ai.sumopod.com/v1",
});

// deepseek-v4-flash: cheap, reliable summarization. It's a reasoning model —
// it consumes tokens on internal chain-of-thought before emitting visible
// content, so max_tokens must be large enough to cover reasoning + output.
// (In testing: ~60-900 reasoning tokens depending on prompt complexity.)
const MODEL = "deepseek-v4-flash";

const WEEKLY_SYSTEM_PROMPT = `You are a weekly standup bot. Given one developer's activity for the week (possibly across multiple repos), grouped by day, write a first-person standup summary as if the developer is speaking in a team meeting. Use EXACTLY this format:

Shipped: <1-2 sentences in first person about what was merged/closed this week — mention specific PR/issue titles and what each accomplished. If work spans multiple repos, name the repo>
In progress: <1-2 sentences in first person about open work — open PRs, recent commit areas, what's being built and its current state>
Reviews: <1 sentence in first person about review activity — how many PRs reviewed, what kind of feedback was given>
Blockers: <1 sentence about potential blockers, or "No blockers right now.">

RULES:
- Write in FIRST PERSON ("I merged...", "I'm working on...") — the developer will read this aloud in a meeting.
- Be specific: mention PR titles, feature names, file areas, AND the repo when work spans multiple repos.
- Give context: explain what the work accomplishes, not just what files changed.
- Each field on its own line, exactly the labels above, colon, then content.
- Do NOT invent details. If a category is empty, write "none" or "No blockers right now."
- DO flag potential blockers: commits mentioning "TODO", "HACK", "FIXME", "workaround", or "revert".
- DO NOT flag "fix typo", "cleanup", "lint", or "format" as blockers.
- Plain text, no markdown, no extra commentary, exactly 4 lines.`;

const DAILY_SYSTEM_PROMPT = `You are a daily standup bot. Given one developer's activity for each day, write a first-person standup summary for EACH day as if the developer is speaking in a team meeting.

Format (one block per day, EXACTLY):
[YYYY-MM-DD] <2-4 sentences in first person>

For each day, cover what the developer did and what it accomplished:
- What I did (specific PRs merged, commits pushed, issues closed/opened — with titles and the impact)
- What I'm working on / what's next (if inferrable from the work that day)
- Blockers if any (commits mentioning TODO, HACK, FIXME, workaround, or revert)

RULES:
- Write in FIRST PERSON ("I merged...", "I started working on...") — the developer will read this aloud.
- Be specific: mention PR titles, feature names, file areas. Not "worked on auth" but "fixed a token refresh race condition in src/auth/."
- Give context: explain what the work accomplishes, not just what files changed.
- One block per day, starting with the date in [YYYY-MM-DD] brackets.
- If a day has no activity, write "[YYYY-MM-DD] No activity."
- Plain text, no markdown, no extra commentary.`;

export interface DayActivityInput {
  prs: { repo: string; title: string; state: string }[];
  issues: { repo: string; title: string; state: string }[];
  commits: { repo: string; message: string; files: string[] }[];
  reviews: { repo: string; prTitle: string; state: string }[];
}

export interface StandupInput {
  login: string;
  windowDays: number;
  byDay: Record<string, DayActivityInput>;
}

export interface StandupOutput {
  login: string;
  summary: string; // weekly structured summary
  dailySummaries: Record<string, string>; // dayKey -> 1-2 sentence summary
}

// Truncate long titles/messages to stay within the token budget.
const MAX_TEXT = 200;
const MAX_COMMITS_PER_DAY = 15;
const MAX_FILES = 3;

function truncate(text: string, max: number): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1) + "…";
}

function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function repoShort(full: string): string {
  // "owner/repo" → "repo" for compactness in the prompt.
  const idx = full.lastIndexOf("/");
  return idx >= 0 ? full.slice(idx + 1) : full;
}

function renderDaySection(
  dateKey: string,
  day: DayActivityInput,
  out: string[]
): void {
  out.push(`${dayLabel(dateKey)} (${dateKey}):`);

  if (day.prs.length > 0) {
    out.push("  Pull Requests:");
    for (const pr of day.prs) {
      out.push(`    - [${pr.state}] (${repoShort(pr.repo)}) ${truncate(pr.title, MAX_TEXT)}`);
    }
  }
  if (day.issues.length > 0) {
    out.push("  Issues:");
    for (const issue of day.issues) {
      out.push(`    - [${issue.state}] (${repoShort(issue.repo)}) ${truncate(issue.title, MAX_TEXT)}`);
    }
  }
  if (day.commits.length > 0) {
    out.push("  Commits:");
    const commits = day.commits.slice(0, MAX_COMMITS_PER_DAY);
    for (const c of commits) {
      const msg = truncate(c.message, MAX_TEXT);
      const files = c.files.slice(0, MAX_FILES);
      let suffix = "";
      if (files.length > 0) {
        const shown = files.join(", ");
        const more = c.files.length > MAX_FILES ? ", …" : "";
        suffix = ` (${shown}${more})`;
      }
      out.push(`    - (${repoShort(c.repo)}) ${msg}${suffix}`);
    }
    if (day.commits.length > MAX_COMMITS_PER_DAY) {
      out.push(`    - …and ${day.commits.length - MAX_COMMITS_PER_DAY} more commits`);
    }
  }
  if (day.reviews.length > 0) {
    out.push("  Reviews:");
    for (const r of day.reviews) {
      out.push(`    - [${r.state}] (${repoShort(r.repo)}) ${truncate(r.prTitle, MAX_TEXT)}`);
    }
  }

  const empty =
    day.prs.length === 0 &&
    day.issues.length === 0 &&
    day.commits.length === 0 &&
    day.reviews.length === 0;
  if (empty) out.push("  (no activity)");
}

/** Build the shared day-grouped activity prompt body. */
function buildActivityPrompt(input: StandupInput): string {
  const out: string[] = [];
  out.push(`Developer: ${input.login}`);
  out.push(`Window: last ${input.windowDays} days`);
  out.push("");

  const dayKeys = Object.keys(input.byDay).sort();
  if (dayKeys.length === 0) {
    out.push("No activity recorded on any day.");
    return out.join("\n");
  }

  for (const dk of dayKeys) {
    renderDaySection(dk, input.byDay[dk], out);
    out.push("");
  }
  return out.join("\n");
}

/**
 * Parse `[YYYY-MM-DD] summary` lines into a map. Only keeps day keys that
 * were present in the input (ignores hallucinated dates).
 */
function parseDailySummaries(
  text: string,
  validDayKeys: Set<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
    if (!m) continue;
    const [, dateKey, summary] = m;
    if (validDayKeys.has(dateKey)) {
      result[dateKey] = summary.trim();
    }
  }
  return result;
}

function rawCounts(input: StandupInput): string {
  let prs = 0,
    issues = 0,
    commits = 0,
    reviews = 0;
  for (const day of Object.values(input.byDay)) {
    prs += day.prs.length;
    issues += day.issues.length;
    commits += day.commits.length;
    reviews += day.reviews.length;
  }
  return `PRs: ${prs}, issues: ${issues}, commits: ${commits}, reviews: ${reviews}`;
}

/**
 * Generate the structured weekly summary. Never throws.
 */
async function generateWeeklySummary(
  input: StandupInput
): Promise<string> {
  const userPrompt = buildActivityPrompt(input);
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: WEEKLY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      console.error("[ai] weekly summary empty for", input.login, {
        finish_reason: completion.choices[0]?.finish_reason,
        choices: completion.choices.length,
        model: completion.model,
        usage: completion.usage,
        raw: JSON.stringify(completion).slice(0, 500),
      });
      return "No summary generated";
    }
    // Ensure exactly the 4 labeled lines; if the model added extra lines,
    // keep only the ones starting with a known label.
    const labels = ["Shipped:", "In progress:", "Reviews:", "Blockers:"];
    const kept = text
      .split("\n")
      .filter((l) => labels.some((label) => l.trim().startsWith(label)));
    if (kept.length === 0) return text;
    // Re-add any missing labels as "none" for a consistent shape.
    const present = new Set(kept.map((l) => l.trim().split(":")[0] + ":"));
    for (const label of labels) {
      if (!present.has(label)) kept.push(`${label} none`);
    }
    // Sort into canonical order.
    kept.sort(
      (a, b) =>
        labels.indexOf(labels.find((l) => a.trim().startsWith(l))!) -
        labels.indexOf(labels.find((l) => b.trim().startsWith(l))!)
    );
    return kept.join("\n");
  } catch (err) {
    console.error("[ai] weekly summary threw for", input.login, err);
    return `AI unavailable — showing raw data (${rawCounts(input)}).`;
  }
}

/**
 * Generate per-day summaries in a single call. Never throws.
 */
async function generateDailySummaries(
  input: StandupInput
): Promise<Record<string, string>> {
  const validDayKeys = new Set(Object.keys(input.byDay));
  if (validDayKeys.size === 0) return {};

  const userPrompt = buildActivityPrompt(input);
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: DAILY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 3000,
    });
    const text = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = parseDailySummaries(text, validDayKeys);
    // Backfill any days the model skipped with a neutral placeholder.
    for (const dk of validDayKeys) {
      if (!parsed[dk]) parsed[dk] = "";
    }
    return parsed;
  } catch (err) {
    console.error("[ai] daily summaries threw for", input.login, err);
    // Leave daily summaries empty — the raw items still render.
    const out: Record<string, string> = {};
    for (const dk of validDayKeys) out[dk] = "";
    return out;
  }
}

/**
 * Generate one author's weekly + daily summaries in parallel. Never throws.
 */
export async function generateStandup(
  input: StandupInput
): Promise<StandupOutput> {
  const [weekly, daily] = await Promise.all([
    generateWeeklySummary(input),
    generateDailySummaries(input),
  ]);
  return {
    login: input.login,
    summary: weekly,
    dailySummaries: daily,
  };
}

/**
 * Generate standups for all authors in parallel. Uses Promise.allSettled so a
 * single author's failure doesn't reject the whole batch.
 */
export async function generateStandups(
  activities: StandupInput[]
): Promise<StandupOutput[]> {
  const results = await Promise.allSettled(
    activities.map((a) => generateStandup(a))
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      login: activities[i].login,
      summary: "Failed to generate summary",
      dailySummaries: {},
    };
  });
}
