"use client";

import { useEffect, useMemo, useState } from "react";

// ---- Types ----
interface DayActivity {
  prs: { repo: string; title: string; state: string }[];
  issues: { repo: string; title: string; state: string }[];
  commits: { repo: string; message: string; files: string[] }[];
  reviews: { repo: string; prTitle: string; state: string }[];
}

interface StandupEntry {
  login: string;
  avatar_url: string;
  summary: string;
  dailySummaries: Record<string, string>;
  byDay: Record<string, DayActivity>;
}

interface StandupStats {
  contributors: number;
  prs: number;
  issues: number;
  commits: number;
  reviews: number;
}

interface StandupResponse {
  repo: string;
  repos: string[];
  standups: StandupEntry[];
  days: string[];
  dateRange: string;
  windowDays: number;
  timezone: string;
  stats: StandupStats;
  warnings?: string[];
  message?: string;
}

interface MeResponse {
  authenticated: boolean;
  login?: string;
  avatarUrl?: string;
}

interface UserRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  updatedAt: string;
  description: string | null;
}

function repoShort(full: string): string {
  const idx = full.lastIndexOf("/");
  return idx >= 0 ? full.slice(idx + 1) : full;
}

function RepoBadge({ repo }: { repo: string }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-500 text-[10px] font-mono shrink-0"
      title={repo}
    >
      {repoShort(repo)}
    </span>
  );
}

// ---- Helpers ----
function countsForDay(day: DayActivity) {
  return {
    prs: day.prs.length,
    issues: day.issues.length,
    commits: day.commits.length,
    reviews: day.reviews.length,
  };
}

function hasActivity(c: ReturnType<typeof countsForDay>): boolean {
  return c.prs + c.issues + c.commits + c.reviews > 0;
}

function dayHeaderLabel(dateKey: string): { weekday: string; date: string; isWeekend: boolean } {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (isNaN(d.getTime())) return { weekday: dateKey, date: "", isWeekend: false };
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(d);
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
  const dow = d.getUTCDay();
  return { weekday, date, isWeekend: dow === 0 || dow === 6 };
}

function firstLine(msg: string, max = 120): string {
  const line = msg.split("\n")[0].trim();
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}

// ---- Components ----
function WeeklySummary({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    return <span className="text-zinc-500">{text || "No summary"}</span>;
  }
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
          return (
            <p key={i} className="text-sm text-zinc-400 leading-relaxed">
              {line}
            </p>
          );
        }
        const label = line.slice(0, colonIdx + 1);
        const value = line.slice(colonIdx + 1).trim();
        const labelColor =
          label.startsWith("Shipped") ? "text-emerald-400" :
          label.startsWith("In progress") ? "text-blue-400" :
          label.startsWith("Reviews") ? "text-purple-400" :
          label.startsWith("Blockers") ? "text-amber-400" :
          "text-zinc-200";
        return (
          <p key={i} className="text-sm leading-relaxed">
            <span className={`font-semibold ${labelColor}`}>{label}</span>{" "}
            <span className="text-zinc-300">{value}</span>
          </p>
        );
      })}
    </div>
  );
}

function TypeBadge({ type, count }: { type: "commits" | "prs" | "issues" | "reviews"; count: number }) {
  const styles = {
    commits: { bg: "bg-sky-500/15", text: "text-sky-300", border: "border-sky-500/20", icon: "◆" },
    prs: { bg: "bg-emerald-500/15", text: "text-emerald-300", border: "border-emerald-500/20", icon: "⇄" },
    issues: { bg: "bg-amber-500/15", text: "text-amber-300", border: "border-amber-500/20", icon: "●" },
    reviews: { bg: "bg-purple-500/15", text: "text-purple-300", border: "border-purple-500/20", icon: "✓" },
  };
  const s = styles[type];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${s.bg} ${s.text} border ${s.border} text-xs font-medium`}>
      <span className="opacity-60">{s.icon}</span>
      {count} {type.replace(/s$/, "")}{count > 1 ? "s" : ""}
    </span>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800 backdrop-blur-sm">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-xs text-zinc-500 uppercase tracking-wide">{label}</span>
    </div>
  );
}

// ---- Main ----
const MAX_REPOS = 5;

export default function Home() {
  const [repoQuery, setRepoQuery] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [repoList, setRepoList] = useState<UserRepo[]>([]);
  const [repoListLoading, setRepoListLoading] = useState(true);
  const [repoListError, setRepoListError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [standups, setStandups] = useState<StandupEntry[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState("");
  const [windowDays, setWindowDays] = useState(7);
  const [repoName, setRepoName] = useState("");
  const [reposCount, setReposCount] = useState(0);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<StandupStats>({ contributors: 0, prs: 0, issues: 0, commits: 0, reviews: 0 });
  const [me, setMe] = useState<MeResponse | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const browserTz = useMemo(
    () => (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || undefined,
    []
  );

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : { authenticated: false }))
      .then((data: MeResponse) => {
        if (active) {
          setMe(data);
          setAuthChecking(false);
          if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("auth_error")) {
            setError("Sign-in failed. Please try again.");
            window.history.replaceState({}, "", "/");
          }
        }
      })
      .catch(() => active && setAuthChecking(false));
    return () => { active = false; };
  }, []);

  // Fetch the user's repos once authenticated.
  useEffect(() => {
    if (!me?.authenticated) return;
    let active = true;
    fetch("/api/repos")
      .then((res) => (res.ok ? res.json() : { repos: [], error: "Failed to load" }))
      .then((data: { repos?: UserRepo[]; error?: string }) => {
        if (!active) return;
        if (data.repos) setRepoList(data.repos);
        else if (data.error) setRepoListError(data.error);
        setRepoListLoading(false);
      })
      .catch(() => {
        if (active) {
          setRepoListError("Could not load your repos.");
          setRepoListLoading(false);
        }
      });
    return () => { active = false; };
  }, [me?.authenticated]);

  function handleLogout() {
    fetch("/api/auth/logout", { method: "GET", redirect: "manual" }).then(() => {
      setMe({ authenticated: false });
      setStandups([]);
      setDays([]);
      setSelectedRepos([]);
    });
  }

  function toggleCell(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addRepo(fullName: string) {
    const clean = fullName.trim();
    if (!clean) return;
    // Normalize: strip github.com URL prefix / .git / trailing slash.
    const normalized = clean
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/^github\.com\//, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    setSelectedRepos((prev) => {
      if (prev.includes(normalized)) return prev;
      if (prev.length >= MAX_REPOS) return prev;
      return [...prev, normalized];
    });
  }

  function removeRepo(fullName: string) {
    setSelectedRepos((prev) => prev.filter((r) => r !== fullName));
  }

  // Filtered list for the dropdown (excludes already-selected).
  const filteredRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase();
    return repoList.filter((r) => {
      if (selectedRepos.includes(r.fullName)) return false;
      if (!q) return true;
      return (
        r.fullName.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [repoList, repoQuery, selectedRepos]);

  const atRepoLimit = selectedRepos.length >= MAX_REPOS;

  async function handleGenerate() {
    if (selectedRepos.length === 0) return;
    setLoading(true);
    setError("");
    setStandups([]);
    setDays([]);
    setDateRange("");
    setExpanded(new Set());
    setStats({ contributors: 0, prs: 0, issues: 0, commits: 0, reviews: 0 });

    try {
      const tzParam = browserTz ? `&tz=${encodeURIComponent(browserTz)}` : "";
      const reposParam = selectedRepos.map(encodeURIComponent).join(",");
      const res = await fetch(`/api/standup?repos=${reposParam}${tzParam}`);
      const data = await res.json();

      if (res.status === 401) {
        setMe({ authenticated: false });
        throw new Error("Your session expired. Please sign in again.");
      }
      if (!res.ok) {
        throw new Error((typeof data.error === "string" && data.error) || "Failed to generate standup");
      }

      const standupData = data as StandupResponse;
      setStandups(standupData.standups);
      setDays(standupData.days);
      setDateRange(standupData.dateRange);
      setWindowDays(standupData.windowDays);
      setRepoName(standupData.repo);
      setReposCount(standupData.repos?.length ?? 0);
      setStats(standupData.stats);

      if (standupData.standups.length === 0 && standupData.message) {
        setError(standupData.message);
      } else if (standupData.warnings?.length) {
        setError(standupData.warnings.join(". "));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function handleCopyAll() {
    if (standups.length === 0) return;
    const text = standups
      .map(
        (s) =>
          `**${s.login}**\n${s.summary}` +
          (Object.keys(s.dailySummaries ?? {}).length > 0
            ? "\n" + Object.keys(s.dailySummaries).sort().map((dk) => `  [${dk}] ${s.dailySummaries[dk]}`).join("\n")
            : "")
      )
      .join("\n\n");
    navigator.clipboard.writeText(text);
  }

  const hasResults = standups.length > 0 && days.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-100">
      {/* Sticky header */}
      <header className="sticky top-0 z-20 backdrop-blur-xl bg-zinc-950/80 border-b border-zinc-800/80">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/fox-logo.svg" alt="GitStandup" className="w-6 h-6" />
            <span className="font-bold text-zinc-100">GitStandup</span>
          </div>
          {me?.authenticated ? (
            <div className="flex items-center gap-3 text-sm">
              {me.avatarUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={me.avatarUrl} alt={me.login} className="w-7 h-7 rounded-full ring-1 ring-zinc-700" />
              )}
              <span className="text-zinc-400 hidden sm:inline">{me.login}</span>
              <button onClick={handleLogout} className="text-zinc-500 hover:text-zinc-200 transition-colors">
                Sign out
              </button>
            </div>
          ) : (
            <a href="/api/auth/login" className="px-4 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 hover:border-zinc-600 hover:bg-zinc-700/80 transition-colors text-sm">
              Sign in with GitHub
            </a>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        {/* Hero / login wall */}
        {authChecking ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-500 rounded-full animate-spin" />
          </div>
        ) : !me?.authenticated ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/fox-logo.svg" alt="GitStandup" className="w-16 h-16 mb-6" />
            <h1 className="text-4xl font-bold mb-3 bg-gradient-to-r from-emerald-400 to-sky-400 bg-clip-text text-transparent">
              GitStandup
            </h1>
            <p className="text-zinc-400 max-w-md mb-8 leading-relaxed">
              Weekly standups from your git history. PRs, commits, issues, reviews —
              whatever your team uses. Including private repos.
            </p>
            <a
              href="/api/auth/login"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-medium transition-all hover:scale-105 shadow-lg shadow-emerald-600/20"
            >
              <svg viewBox="0 0 16 16" className="w-5 h-5 fill-current" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Sign in with GitHub
            </a>
          </div>
        ) : (
          <>
            {/* Title + picker */}
            <div className="mb-8">
              <h1 className="text-3xl font-bold mb-2">
                {repoName ? (
                  <>
                    <span className="text-zinc-500">Standup for</span>{" "}
                    <span className="text-emerald-400">{repoName}</span>
                  </>
                ) : (
                  "Weekly Standup"
                )}
              </h1>
              <p className="text-zinc-400 mb-6">
                Select up to {MAX_REPOS} repos — search your own, or type any{" "}
                <code className="text-zinc-500 text-sm">owner/repo</code> and press Enter.
              </p>

              {/* Selected repo chips */}
              {selectedRepos.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {selectedRepos.map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-sm"
                    >
                      {r}
                      <button
                        onClick={() => removeRepo(r)}
                        className="w-5 h-5 rounded-full hover:bg-emerald-500/20 flex items-center justify-center text-emerald-400"
                        aria-label={`Remove ${r}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-3">
                {/* Picker */}
                <div className="relative flex-1">
                  <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    type="text"
                    value={repoQuery}
                    onChange={(e) => setRepoQuery(e.target.value)}
                    onFocus={() => setPickerOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (filteredRepos.length > 0 && !atRepoLimit) {
                          addRepo(filteredRepos[0].fullName);
                        } else if (repoQuery.trim() && !atRepoLimit) {
                          addRepo(repoQuery.trim());
                        }
                        setRepoQuery("");
                      }
                    }}
                    placeholder={atRepoLimit ? `Max ${MAX_REPOS} repos reached` : "Search your repos or type owner/repo…"}
                    disabled={atRepoLimit}
                    className="w-full pl-12 pr-4 py-3 rounded-xl bg-zinc-900/80 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-all backdrop-blur-sm disabled:opacity-50"
                  />
                  {pickerOpen && !atRepoLimit && (
                    <div className="absolute z-30 mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/40 max-h-72 overflow-auto">
                      {repoListLoading ? (
                        <div className="p-4 text-sm text-zinc-500 flex items-center gap-2">
                          <div className="w-4 h-4 border-2 border-zinc-700 border-t-emerald-500 rounded-full animate-spin" />
                          Loading your repos…
                        </div>
                      ) : repoListError ? (
                        <div className="p-4 text-sm text-amber-400">{repoListError} You can still type owner/repo manually.</div>
                      ) : filteredRepos.length === 0 ? (
                        <div className="p-4 text-sm text-zinc-500">
                          {repoQuery.trim()
                            ? `No repos match "${repoQuery}". Press Enter to add "${repoQuery.trim()}" manually.`
                            : "No repos found."}
                        </div>
                      ) : (
                        <ul className="py-1">
                          {filteredRepos.slice(0, 50).map((r) => (
                            <li key={r.fullName}>
                              <button
                                onClick={() => {
                                  addRepo(r.fullName);
                                  setRepoQuery("");
                                }}
                                className="w-full text-left px-4 py-2.5 hover:bg-zinc-800/80 flex items-center justify-between gap-3"
                              >
                                <span className="min-w-0">
                                  <span className="text-sm text-zinc-200 truncate block">{r.fullName}</span>
                                  {r.description && (
                                    <span className="text-xs text-zinc-500 truncate block">{r.description}</span>
                                  )}
                                </span>
                                {r.private && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 shrink-0">
                                    private
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={loading || selectedRepos.length === 0}
                  className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-all shadow-lg shadow-emerald-600/20 flex items-center gap-2"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Generating...
                    </>
                  ) : (
                    "Generate"
                  )}
                </button>
              </div>
              {atRepoLimit && (
                <p className="text-xs text-amber-400 mt-2">
                  Max {MAX_REPOS} repos reached — remove one to add another.
                </p>
              )}
            </div>

            {/* Click-away backdrop for the picker */}
            {pickerOpen && (
              <div
                className="fixed inset-0 z-20"
                onClick={() => setPickerOpen(false)}
                aria-hidden
              />
            )}

            {/* Error / notice */}
            {error && (
              <div className="p-4 mb-6 rounded-xl bg-red-950/40 border border-red-900/60 text-red-300 text-sm flex items-start gap-3">
                <span className="text-red-400 mt-0.5">⚠</span>
                <span>{error}</span>
              </div>
            )}

            {/* Stats + date range */}
            {hasResults && (
              <div className="mb-6">
                {dateRange && (
                  <div className="flex items-center gap-2 mb-3 text-zinc-400">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span className="font-medium text-zinc-300">{dateRange}</span>
                    <span className="text-zinc-600">·</span>
                    <span>last {windowDays} days</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2.5">
                  {reposCount > 0 && (
                    <StatPill label="Repos" value={reposCount} color="text-emerald-400" />
                  )}
                  <StatPill label="Contributors" value={stats.contributors} color="text-emerald-400" />
                  <StatPill label="PRs" value={stats.prs} color="text-sky-400" />
                  <StatPill label="Issues" value={stats.issues} color="text-amber-400" />
                  <StatPill label="Commits" value={stats.commits} color="text-blue-400" />
                  <StatPill label="Reviews" value={stats.reviews} color="text-purple-400" />
                  <button
                    onClick={handleCopyAll}
                    className="ml-auto flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-sm"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    Copy all
                  </button>
                </div>
              </div>
            )}

            {/* Calendar grid */}
            {hasResults && (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="sticky left-0 z-10 bg-zinc-900/95 backdrop-blur-sm text-left p-4 text-zinc-500 font-medium text-xs uppercase tracking-wide min-w-[280px]">
                          Contributor
                        </th>
                        {days.map((dk) => {
                          const { weekday, date, isWeekend } = dayHeaderLabel(dk);
                          return (
                            <th
                              key={dk}
                              className={`p-4 text-center font-medium border-b border-l border-zinc-800 min-w-[160px] ${isWeekend ? "bg-zinc-900/40" : ""}`}
                            >
                              <div className={`text-sm ${isWeekend ? "text-zinc-500" : "text-zinc-300"}`}>{weekday}</div>
                              <div className="text-xs text-zinc-600 mt-0.5">{date}</div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {standups.map((entry) => (
                        <tr key={entry.login} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/20 transition-colors">
                          {/* Author + weekly summary */}
                          <td className="sticky left-0 z-10 bg-zinc-900/95 backdrop-blur-sm p-4 align-top min-w-[280px] max-w-[320px]">
                            <div className="flex items-center gap-2.5 mb-3">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={entry.avatar_url}
                                alt={entry.login}
                                className="w-9 h-9 rounded-full ring-2 ring-zinc-800"
                              />
                              <span className="font-semibold text-zinc-100">{entry.login}</span>
                            </div>
                            <WeeklySummary text={entry.summary} />
                          </td>

                          {/* Day cells */}
                          {days.map((dk) => {
                            const day = entry.byDay[dk];
                            const { isWeekend } = dayHeaderLabel(dk);
                            const c = day ? countsForDay(day) : { prs: 0, issues: 0, commits: 0, reviews: 0 };
                            const cellKey = `${entry.login}|${dk}`;
                            const isOpen = expanded.has(cellKey);

                            if (!day || !hasActivity(c)) {
                              return (
                                <td key={dk} className={`p-4 border-l border-zinc-800/60 text-center align-middle ${isWeekend ? "bg-zinc-900/30" : ""}`}>
                                  <span className="text-zinc-700 text-xs">—</span>
                                </td>
                              );
                            }

                            return (
                              <td key={dk} className={`p-3 border-l border-zinc-800/60 align-top ${isWeekend ? "bg-zinc-900/30" : ""}`}>
                                <button
                                  onClick={() => toggleCell(cellKey)}
                                  className="flex flex-wrap gap-1.5 items-center group"
                                >
                                  {c.commits > 0 && <TypeBadge type="commits" count={c.commits} />}
                                  {c.prs > 0 && <TypeBadge type="prs" count={c.prs} />}
                                  {c.issues > 0 && <TypeBadge type="issues" count={c.issues} />}
                                  {c.reviews > 0 && <TypeBadge type="reviews" count={c.reviews} />}
                                  <span className="text-zinc-600 group-hover:text-zinc-300 text-xs ml-0.5 transition-colors">
                                    {isOpen ? "▾" : "▸"}
                                  </span>
                                </button>
                                {isOpen && (
                                  <div className="mt-3 space-y-2.5 text-left border-t border-zinc-800/60 pt-3">
                                    {entry.dailySummaries?.[dk]?.trim() && (
                                      <div className="p-2.5 rounded-lg bg-emerald-950/30 border border-emerald-900/40">
                                        <p className="text-xs text-emerald-100/90 italic leading-relaxed">
                                          {entry.dailySummaries[dk]}
                                        </p>
                                      </div>
                                    )}
                                    {day.prs.map((pr, i) => (
                                      <div key={`pr${i}`} className="flex items-start gap-1.5 text-xs">
                                        <span className="text-emerald-400 mt-0.5 shrink-0">⇄</span>
                                        <span className="text-zinc-300">
                                          <RepoBadge repo={pr.repo} />{" "}
                                          <span className="text-emerald-500/80">[{pr.state}]</span> {firstLine(pr.title)}
                                        </span>
                                      </div>
                                    ))}
                                    {day.issues.map((is, i) => (
                                      <div key={`is${i}`} className="flex items-start gap-1.5 text-xs">
                                        <span className="text-amber-400 mt-0.5 shrink-0">●</span>
                                        <span className="text-zinc-300">
                                          <RepoBadge repo={is.repo} />{" "}
                                          <span className="text-amber-500/80">[{is.state}]</span> {firstLine(is.title)}
                                        </span>
                                      </div>
                                    ))}
                                    {day.commits.map((cm, i) => (
                                      <div key={`cm${i}`} className="flex items-start gap-1.5 text-xs">
                                        <span className="text-sky-400 mt-0.5 shrink-0">◆</span>
                                        <span className="text-zinc-300">
                                          <RepoBadge repo={cm.repo} />{" "}
                                          {firstLine(cm.message)}
                                        </span>
                                      </div>
                                    ))}
                                    {day.reviews.map((rv, i) => (
                                      <div key={`rv${i}`} className="flex items-start gap-1.5 text-xs">
                                        <span className="text-purple-400 mt-0.5 shrink-0">✓</span>
                                        <span className="text-zinc-300">
                                          <RepoBadge repo={rv.repo} />{" "}
                                          <span className="text-purple-500/80">[{rv.state}]</span> {firstLine(rv.prTitle)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Empty state */}
            {standups.length === 0 && !loading && !error && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4 opacity-40">📋</div>
                <p className="text-zinc-500">Select one or more repos above to generate this week&apos;s standup.</p>
              </div>
            )}

            {/* Loading skeletons */}
            {loading && (
              <div className="space-y-3">
                <div className="h-20 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 animate-pulse" />
                <div className="h-64 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 animate-pulse" />
                <div className="h-64 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 animate-pulse" />
              </div>
            )}
          </>
        )}

        <p className="text-center text-zinc-700 text-xs mt-16">
          Weekly standups from your git history
        </p>
      </main>
    </div>
  );
}
