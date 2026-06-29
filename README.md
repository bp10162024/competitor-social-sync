# competitor-social-sync

Weekly competitor **social media** tracker for Buddy Punch. Scrapes the 20 tracked competitors' public Instagram, TikTok, YouTube, and LinkedIn accounts via Apify, snapshots the metrics into the Oracle warehouse, and posts a week-over-week digest to Slack `#marketing-amy-chat`. The same warehouse table powers a `competitor_social` capability in Buddy so anyone can ask "what are competitors doing on social".

## How it works

1. **Handles** live in Supabase `oracle_competitor_social_handles` (one row per competitor × platform; `handle` = exactly what the actor consumes — IG/TikTok username, YouTube channel URL, LinkedIn company URL). Edit that table to add/fix accounts — no redeploy.
2. **Weekly cron** (Mon 06:00 America/Chicago) runs one Apify actor per platform with all that platform's handles batched, normalizes the output, and upserts one snapshot per competitor/platform/week into `oracle_competitor_social` (unique on `domain,platform,week_start`).
3. **Digest** computes follower deltas vs. the prior snapshot, writes an AI "what's working this week" brief (Opus 4.8, Sonnet fallback), and posts header + per-platform sections + top posts to Slack.

## Actors

| Platform | Apify actor |
|---|---|
| Instagram | `apify/instagram-profile-scraper` |
| TikTok | `clockworks/tiktok-profile-scraper` |
| YouTube | `streamers/youtube-channel-scraper` |
| LinkedIn | `automation-lab/linkedin-company-scraper` |

Normalizers in `lib/platforms.js` read multiple candidate field names defensively and store the trimmed `raw` item, so a field-name drift degrades gracefully instead of losing the row.

## Endpoints

- `GET /health` → `OK` (Railway health check)
- `GET /status` → `{ isRunning, lastRun }`
- `POST /run?token=RUN_TOKEN[&digest=false]` → kicks off a sync in the background (returns 202; the full run takes several minutes)

## Env vars

`APIFY_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY` (service role), `SLACK_BOT_TOKEN` (a bot in `#marketing-amy-chat`), `DIGEST_CHANNEL_ID`, `RUN_TOKEN`, `ANTHROPIC_API_KEY`, `COMPETITOR_SOCIAL_MODEL` (default `claude-opus-4-8`), `PORT`.

## Tables

- `oracle_competitor_social_handles` — config (domain, name, platform, handle, profile_url, enabled, verified)
- `oracle_competitor_social` — weekly snapshots (followers, following, post_count, avg_likes/comments/views, engagement_rate, recent_posts, raw, scrape_ok)

Both in Supabase project `ltbyatmaovlbcldgdtij` (the "competitor-dashboard" project that holds the Oracle warehouse tables).
