/* MET Practice by DBL: bookmarks, performance saving and analytics.
 *
 * Requires: a Supabase client named `supabase`, a signed-in user, and the
 * `bookmarks` and `user_performances` tables from the migration.
 * user_id is filled in by the database (default auth.uid()), so it is never sent.
 *
 * NOTE: if the supabase-js CDN script is loaded, `window.supabase` is the LIBRARY,
 * not a client. Create your client under another name, for example
 *   const supabase = window.supabase.createClient(URL, KEY)   // inside a module/IIFE
 * or just change the one line below to point at your client (e.g. `sb`).
 */
const db = () => supabase;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws a readable Error for any Supabase error. */
function assertOk(error, action) {
  if (error) {
    const err = new Error(`${action}: ${error.message || "unknown error"}`);
    err.code = error.code;
    err.cause = error;
    throw err;
  }
}

/** Returns the signed-in user's id, or throws if nobody is signed in. */
async function requireUserId() {
  const { data, error } = await db().auth.getUser();
  assertOk(error, "Could not verify your session");
  if (!data?.user) throw new Error("You must be signed in.");
  return data.user.id;
}

/* ------------------------------------------------------------------ */
/* 1. Bookmarks                                                        */
/* ------------------------------------------------------------------ */

/**
 * Adds the bookmark if it does not exist, removes it if it does.
 * Safe against double clicks and two open tabs (unique constraint + delete-first).
 * @param {string} questionId uuid of a row in public.questions
 * @returns {Promise<{bookmarked: boolean}>} the new state
 */
async function toggleBookmark(questionId) {
  if (!UUID_RE.test(questionId || "")) throw new Error("Invalid question id.");
  await requireUserId();

  // Try to remove first. RLS limits this to the caller's own rows.
  const { data: removed, error: delError } = await db()
    .from("bookmarks")
    .delete()
    .eq("question_id", questionId)
    .select("id");
  assertOk(delError, "Could not remove bookmark");
  if (removed && removed.length) return { bookmarked: false };

  // Nothing to remove, so add it.
  const { error: insError } = await db()
    .from("bookmarks")
    .insert({ question_id: questionId });

  // 23505 = unique violation: another tab added it a moment ago. It is bookmarked either way.
  if (insError && insError.code !== "23505") assertOk(insError, "Could not add bookmark");
  return { bookmarked: true };
}

/**
 * Loads all of the user's bookmarked question ids.
 * @returns {Promise<Set<string>>}
 */
async function getBookmarkedIds() {
  const { data, error } = await db().from("bookmarks").select("question_id");
  assertOk(error, "Could not load bookmarks");
  return new Set((data || []).map((r) => r.question_id));
}

/* ------------------------------------------------------------------ */
/* 2. Save a result                                                    */
/* ------------------------------------------------------------------ */

/**
 * Saves one finished session. `percentage` and `completed_at` are set by the database.
 * @param {string} bankName
 * @param {number} score            correct answers
 * @param {number} totalQuestions   questions in the session
 * @returns {Promise<{id:string, bank:string, score:number, total_questions:number, percentage:number, completed_at:string}>}
 */
async function saveTestPerformance(bankName, score, totalQuestions) {
  const bank = String(bankName ?? "").trim();
  if (!bank) throw new Error("Bank name is required.");
  if (!Number.isInteger(score) || !Number.isInteger(totalQuestions))
    throw new Error("Score and total questions must be whole numbers.");
  if (totalQuestions <= 0) throw new Error("Total questions must be greater than zero.");
  if (score < 0 || score > totalQuestions)
    throw new Error("Score must be between 0 and the total number of questions.");
  await requireUserId();

  const { data, error } = await db()
    .from("user_performances")
    .insert({ bank, score, total_questions: totalQuestions })
    .select("id, bank, score, total_questions, percentage, completed_at")
    .single();
  assertOk(error, "Could not save your result");
  return { ...data, percentage: Number(data.percentage) };
}

/* ------------------------------------------------------------------ */
/* 3. Analytics                                                        */
/* ------------------------------------------------------------------ */

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA"); // YYYY-MM-DD in the user's timezone

/**
 * Builds a summary of the user's history (most recent 1000 sessions).
 * @returns {Promise<{
 *   totalTests:number, totalQuestions:number, totalCorrect:number,
 *   overallPercentage:number, averageTestPercentage:number,
 *   best:object|null, latest:object|null,
 *   recent:object[], banks:object[],
 *   trend:{recentAvg:number, previousAvg:number, change:number}|null,
 *   streakDays:number, bookmarkCount:number
 * }>}
 */
async function getUserAnalytics() {
  await requireUserId();

  const [perfRes, bmRes] = await Promise.all([
    db()
      .from("user_performances")
      .select("id, bank, score, total_questions, percentage, completed_at")
      .order("completed_at", { ascending: false })
      .limit(1000),
    db().from("bookmarks").select("id", { count: "exact", head: true }),
  ]);
  assertOk(perfRes.error, "Could not load your results");
  assertOk(bmRes.error, "Could not load your bookmarks");

  // Newest first, with numeric percentages.
  const rows = (perfRes.data || []).map((r) => ({ ...r, percentage: Number(r.percentage) }));

  const totalCorrect = rows.reduce((s, r) => s + r.score, 0);
  const totalQuestions = rows.reduce((s, r) => s + r.total_questions, 0);

  // Per-bank breakdown
  const byBank = new Map();
  for (const r of rows) {
    if (!byBank.has(r.bank)) byBank.set(r.bank, []);
    byBank.get(r.bank).push(r);
  }
  const banks = [...byBank.entries()]
    .map(([bank, list]) => {
      const correct = list.reduce((s, r) => s + r.score, 0);
      const total = list.reduce((s, r) => s + r.total_questions, 0);
      return {
        bank,
        attempts: list.length,
        totalCorrect: correct,
        totalQuestions: total,
        overallPercentage: total ? round1((correct / total) * 100) : 0,
        bestPercentage: Math.max(...list.map((r) => r.percentage)),
        latestPercentage: list[0].percentage, // list is newest first
        lastCompletedAt: list[0].completed_at,
      };
    })
    .sort((a, b) => b.attempts - a.attempts || a.bank.localeCompare(b.bank));

  // Trend: average of the latest 5 sessions vs the 5 before them
  let trend = null;
  if (rows.length >= 6) {
    const recentAvg = avg(rows.slice(0, 5).map((r) => r.percentage));
    const previousAvg = avg(rows.slice(5, 10).map((r) => r.percentage));
    trend = {
      recentAvg: round1(recentAvg),
      previousAvg: round1(previousAvg),
      change: round1(recentAvg - previousAvg),
    };
  }

  // Streak: consecutive calendar days with at least one session, ending today or yesterday
  const days = new Set(rows.map((r) => dayKey(r.completed_at)));
  let streakDays = 0;
  const cursor = new Date();
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor))) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    totalTests: rows.length,
    totalQuestions,
    totalCorrect,
    overallPercentage: totalQuestions ? round1((totalCorrect / totalQuestions) * 100) : 0,
    averageTestPercentage: round1(avg(rows.map((r) => r.percentage))),
    best: rows.length ? rows.reduce((a, b) => (b.percentage > a.percentage ? b : a)) : null,
    latest: rows[0] || null,
    recent: rows.slice(0, 10),
    banks,
    trend,
    streakDays,
    bookmarkCount: bmRes.count || 0,
  };
}
