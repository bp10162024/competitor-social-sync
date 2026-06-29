const express = require("express");
const cron = require("node-cron");
const { runActor } = require("./lib/apify");
const { PLATFORMS } = require("./lib/platforms");
const { weekStartOf, getEnabledHandles, upsertSnapshot, getSnapshots, getPriorSnapshotMap } = require("./lib/supa");
const { postDigest } = require("./lib/digest");

const PORT = process.env.PORT || 3000;
const RUN_TOKEN = process.env.RUN_TOKEN || "";

let isRunning = false;
let lastRun = null; // summary of the most recent run

async function runSync({ digest = true } = {}) {
  if (isRunning) return { skipped: "already running" };
  isRunning = true;
  const started = new Date().toISOString();
  const weekStart = weekStartOf();
  const results = [];
  try {
    const handles = await getEnabledHandles();
    const byPlat = {};
    for (const h of handles) (byPlat[h.platform] ||= []).push(h);

    for (const platform of Object.keys(PLATFORMS)) {
      const hs = byPlat[platform] || [];
      if (!hs.length) continue;
      try {
        console.log(`[sync] ${platform}: scraping ${hs.length} handles via ${PLATFORMS[platform].actor}`);
        const items = await runActor(PLATFORMS[platform].actor, PLATFORMS[platform].buildInput(hs));
        const rows = PLATFORMS[platform].normalize(items, hs);
        for (const r of rows) await upsertSnapshot({ ...r, scrape_ok: true }, weekStart);
        const matched = new Set(rows.map((r) => r.domain));
        const unmatched = hs.filter((h) => !matched.has(h.domain)).map((h) => h.domain);
        console.log(`[sync] ${platform}: ${items.length} items -> ${rows.length} stored; unmatched: ${unmatched.join(", ") || "none"}`);
        results.push({ platform, handles: hs.length, items: items.length, stored: rows.length, unmatched });
      } catch (e) {
        console.error(`[sync] ${platform} FAILED:`, e.message);
        results.push({ platform, error: e.message });
      }
    }

    let messages = 0;
    if (digest) {
      const snaps = await getSnapshots(weekStart);
      const prior = await getPriorSnapshotMap(weekStart);
      messages = await postDigest(snaps, prior, weekStart);
      console.log(`[sync] digest posted: ${messages} message(s) to ${process.env.DIGEST_CHANNEL_ID}`);
    }
    lastRun = { started, finished: new Date().toISOString(), weekStart, results, messages };
    return lastRun;
  } finally {
    isRunning = false;
  }
}

const app = express();
app.get("/health", (_req, res) => res.send("OK"));
app.get("/status", (_req, res) => res.json({ isRunning, lastRun }));

// Digest-only: rebuild & post from the latest stored snapshots (no scrape). Token-gated.
app.post("/digest", async (req, res) => {
  const token = req.query.token || req.headers["x-run-token"];
  if (!RUN_TOKEN || token !== RUN_TOKEN) return res.status(403).json({ error: "forbidden" });
  try {
    const weekStart = weekStartOf();
    const snaps = await getSnapshots(weekStart);
    const prior = await getPriorSnapshotMap(weekStart);
    const messages = await postDigest(snaps, prior, weekStart);
    res.json({ ok: true, weekStart, snapshots: snaps.length, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger. Long-running, so kick off in the background and return immediately.
app.post("/run", (req, res) => {
  const token = req.query.token || req.headers["x-run-token"];
  if (!RUN_TOKEN || token !== RUN_TOKEN) return res.status(403).json({ error: "forbidden" });
  if (isRunning) return res.status(409).json({ error: "already running" });
  const digest = req.query.digest !== "false";
  runSync({ digest }).catch((e) => console.error("[run] error:", e.message));
  res.status(202).json({ started: true, digest, note: "running in background; see /status and Slack" });
});

app.listen(PORT, () => console.log(`competitor-social-sync listening on ${PORT}`));

// Weekly: Monday 06:00 America/Chicago
cron.schedule("0 6 * * 1", () => {
  console.log("[cron] weekly competitor social sync starting");
  runSync({ digest: true }).catch((e) => console.error("[cron] error:", e.message));
}, { timezone: "America/Chicago" });

console.log("competitor-social-sync booted; weekly cron = Mon 06:00 CT");
