const Anthropic = require("@anthropic-ai/sdk");

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.DIGEST_CHANNEL_ID;
const MODEL = process.env.COMPETITOR_SOCIAL_MODEL || "claude-opus-4-8";
const FALLBACK_MODEL = "claude-sonnet-4-6";

const PLAT = {
  instagram: { emoji: ":camera_with_flash:", label: "Instagram" },
  tiktok: { emoji: ":musical_note:", label: "TikTok" },
  youtube: { emoji: ":arrow_forward:", label: "YouTube" },
  linkedin: { emoji: ":briefcase:", label: "LinkedIn" },
};
const PLAT_ORDER = ["instagram", "tiktok", "youtube", "linkedin"];

function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtDelta(cur, prev) {
  if (cur == null || prev == null) return "";
  const d = cur - prev;
  if (d === 0) return " (±0)";
  const arrow = d > 0 ? ":small_red_triangle:" : ":small_red_triangle_down:";
  return ` (${arrow} ${d > 0 ? "+" : "-"}${fmtNum(Math.abs(d))})`;
}

async function slackPost(text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false, unfurl_media: false }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error("slack postMessage: " + j.error);
  return j.ts;
}

async function aiNarrative(snapshots, priorMap) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const byPlat = {};
  for (const s of snapshots) {
    if (!s.scrape_ok || s.followers == null) continue;
    (byPlat[s.platform] ||= []).push({
      name: s.name,
      followers: s.followers,
      follower_delta: priorMap[`${s.domain}|${s.platform}`] ? s.followers - priorMap[`${s.domain}|${s.platform}`].followers : null,
      engagement_rate_pct: s.engagement_rate,
      avg_likes: s.avg_likes, avg_comments: s.avg_comments, avg_views: s.avg_views,
      top_posts: (s.recent_posts || [])
        .slice()
        .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
        .slice(0, 3)
        .map((p) => ({ likes: p.likes, comments: p.comments, views: p.views, caption: p.caption })),
    });
  }
  const prompt = `You are a social media analyst for Buddy Punch (time-tracking SaaS). Below is this week's competitor social data across platforms. Write a SHORT, punchy "What's working on competitors' social this week" brief for our Social Media Manager (Amy).

Rules:
- 4 to 6 bullets max. Each one sentence.
- Focus on what is ACTIONABLE: content formats/themes that are driving engagement, who is growing fastest, what we could try.
- Cite specific competitors and numbers. No fluff, no preamble.
- Output Slack mrkdwn bullets starting with "• ". No header.

DATA (JSON):
${JSON.stringify(byPlat).slice(0, 12000)}`;

  const call = async (model) =>
    client.messages.create({ model, max_tokens: 700, messages: [{ role: "user", content: prompt }] });
  try {
    let r;
    try { r = await call(MODEL); }
    catch (e) { if (/not.*available|not_found|404|model/i.test(String(e?.message))) r = await call(FALLBACK_MODEL); else throw e; }
    return (r.content || []).map((b) => b.text || "").join("").trim();
  } catch (e) {
    console.error("[digest] AI narrative failed:", e.message);
    return null;
  }
}

function platformSection(platform, snaps, priorMap) {
  const meta = PLAT[platform];
  const rows = snaps
    .filter((s) => s.platform === platform && s.scrape_ok && s.followers != null)
    .sort((a, b) => (b.followers || 0) - (a.followers || 0));
  if (!rows.length) return null;
  const lines = [`${meta.emoji} *${meta.label}*`];
  for (const s of rows) {
    const prev = priorMap[`${s.domain}|${s.platform}`];
    const delta = fmtDelta(s.followers, prev ? prev.followers : null);
    let tail = "";
    if (platform === "linkedin") {
      const emp = s.raw && (s.raw.employeeCount || s.raw.employees);
      tail = emp ? ` · ${emp} staff` : "";
    } else {
      tail = s.engagement_rate != null ? ` · eng ${s.engagement_rate}%` : "";
    }
    lines.push(`   • *${s.name}* — ${fmtNum(s.followers)} followers${delta}${tail}`);
  }
  return lines.join("\n");
}

function topPostsSection(snapshots) {
  const posts = [];
  for (const s of snapshots) {
    if (s.platform === "linkedin") continue;
    for (const p of s.recent_posts || []) {
      posts.push({ name: s.name, platform: s.platform, score: (p.likes || 0) + (p.comments || 0), ...p });
    }
  }
  posts.sort((a, b) => b.score - a.score);
  const top = posts.slice(0, 5);
  if (!top.length) return null;
  const lines = [":fire: *Top posts this week*"];
  for (const p of top) {
    const cap = (p.caption || "").replace(/\s+/g, " ").slice(0, 70);
    const link = p.url ? `<${p.url}|${p.name} (${PLAT[p.platform].label})>` : `${p.name} (${PLAT[p.platform].label})`;
    const eng = `${p.likes || 0}:heart: ${p.comments || 0}:speech_balloon:${p.views ? " " + fmtNum(p.views) + " views" : ""}`;
    lines.push(`   • ${link}: ${eng} — “${cap}”`);
  }
  return lines.join("\n");
}

// Build & post the digest. Returns the number of Slack messages sent.
async function postDigest(snapshots, priorMap, weekStart) {
  const ok = snapshots.filter((s) => s.scrape_ok && s.followers != null);
  const platformsCovered = new Set(ok.map((s) => s.platform)).size;
  const competitorsCovered = new Set(ok.map((s) => s.domain)).size;

  const header =
    `:bar_chart: *Competitor Social — Weekly Digest* · week of ${weekStart}\n` +
    `_${ok.length} accounts across ${platformsCovered} platforms · ${competitorsCovered} competitors · vs. prior snapshot_`;

  const narrative = await aiNarrative(snapshots, priorMap);
  let msg1 = header;
  if (narrative) msg1 += `\n\n:bulb: *What's working this week*\n${narrative}`;

  const sent = [];
  sent.push(await slackPost(msg1.slice(0, 3900)));

  for (const p of PLAT_ORDER) {
    const sec = platformSection(p, snapshots, priorMap);
    if (sec) sent.push(await slackPost(sec.slice(0, 3900)));
  }

  const top = topPostsSection(snapshots);
  let footer = ":mag: Ask *Buddy* — _“what are competitors doing on social”_ — for any account in detail.";
  if (top) footer = `${top}\n\n${footer}`;
  sent.push(await slackPost(footer.slice(0, 3900)));

  return sent.length;
}

module.exports = { postDigest, slackPost };
