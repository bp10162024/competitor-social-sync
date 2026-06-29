const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
});

const HANDLES = "oracle_competitor_social_handles";
const SNAPS = "oracle_competitor_social";

// Monday (UTC date) of the week containing `d`, as YYYY-MM-DD. Uses Central Time for the week boundary.
function weekStartOf(d = new Date()) {
  // shift to America/Chicago wall-clock, then find Monday
  const ct = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day = ct.getDay(); // 0 Sun .. 6 Sat
  const diff = (day + 6) % 7; // days since Monday
  ct.setDate(ct.getDate() - diff);
  const y = ct.getFullYear();
  const m = String(ct.getMonth() + 1).padStart(2, "0");
  const dd = String(ct.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function getEnabledHandles() {
  const { data, error } = await supabase
    .from(HANDLES)
    .select("domain,name,platform,handle,profile_url")
    .eq("enabled", true)
    .not("handle", "is", null);
  if (error) throw new Error("getEnabledHandles: " + error.message);
  return data || [];
}

async function upsertSnapshot(row, weekStart) {
  const record = {
    domain: row.domain, name: row.name, platform: row.platform,
    week_start: weekStart, captured_at: new Date().toISOString(),
    followers: row.followers ?? null, following: row.following ?? null,
    post_count: row.post_count ?? null, avg_likes: row.avg_likes ?? null,
    avg_comments: row.avg_comments ?? null, avg_views: row.avg_views ?? null,
    engagement_rate: row.engagement_rate ?? null, posts_sampled: row.posts_sampled ?? 0,
    newest_post_at: row.newest_post_at ?? null, recent_posts: row.recent_posts ?? null,
    raw: row.raw ?? null, scrape_ok: row.scrape_ok !== false, scrape_error: row.scrape_error ?? null,
  };
  const { error } = await supabase.from(SNAPS).upsert(record, { onConflict: "domain,platform,week_start" });
  if (error) throw new Error(`upsert ${row.domain}/${row.platform}: ` + error.message);
}

async function getSnapshots(weekStart) {
  const { data, error } = await supabase.from(SNAPS).select("*").eq("week_start", weekStart);
  if (error) throw new Error("getSnapshots: " + error.message);
  return data || [];
}

// For each (domain,platform), the most recent snapshot with week_start < weekStart.
async function getPriorSnapshotMap(weekStart) {
  const { data, error } = await supabase
    .from(SNAPS).select("domain,platform,week_start,followers")
    .lt("week_start", weekStart)
    .order("week_start", { ascending: false });
  if (error) throw new Error("getPriorSnapshotMap: " + error.message);
  const map = {};
  for (const r of data || []) {
    const k = `${r.domain}|${r.platform}`;
    if (!map[k]) map[k] = r; // first seen = most recent
  }
  return map;
}

module.exports = { supabase, weekStartOf, getEnabledHandles, upsertSnapshot, getSnapshots, getPriorSnapshotMap };
