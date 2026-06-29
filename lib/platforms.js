// Per-platform Apify adapters.
// Each adapter: { actor, buildInput(handles), normalize(items, handles) -> [{domain,name,platform,metrics...}] }
// Normalizers read multiple candidate field names defensively and ALWAYS keep enough
// to recompute. The raw item is preserved by the caller for first-run auditing.

const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const norm = (s) => String(s || "").toLowerCase().replace(/^@/, "").trim();
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function summarize(recent, followers) {
  const likes = recent.map((p) => p.likes).filter((x) => x != null);
  const comments = recent.map((p) => p.comments).filter((x) => x != null);
  const views = recent.map((p) => p.views).filter((x) => x != null);
  const avgLikes = avg(likes);
  const avgComments = avg(comments);
  const avgViews = avg(views);
  const eng = (avgLikes || 0) + (avgComments || 0);
  const engagement_rate = followers && followers > 0 ? Number(((eng / followers) * 100).toFixed(4)) : null;
  // some actors (YouTube) return relative dates like "6 days ago" — only keep parseable ISO timestamps
  const dates = recent.map((p) => p.ts).filter(Boolean)
    .map((t) => { const d = new Date(t); return isNaN(d.getTime()) ? null : d.toISOString(); })
    .filter(Boolean).sort();
  return {
    avg_likes: avgLikes != null ? Number(avgLikes.toFixed(1)) : null,
    avg_comments: avgComments != null ? Number(avgComments.toFixed(1)) : null,
    avg_views: avgViews != null ? Number(avgViews.toFixed(0)) : null,
    engagement_rate,
    posts_sampled: recent.length,
    newest_post_at: dates.length ? dates[dates.length - 1] : null,
    recent_posts: recent.slice(0, 8),
  };
}

const PLATFORMS = {
  instagram: {
    actor: "apify/instagram-profile-scraper",
    buildInput: (handles) => ({ usernames: handles.map((h) => h.handle) }),
    normalize: (items, handles) => {
      const out = [];
      for (const h of handles) {
        const it = items.find((x) => norm(x.username) === norm(h.handle));
        if (!it) continue;
        const followers = num(it.followersCount);
        const recent = (it.latestPosts || []).map((p) => ({
          type: p.type, likes: num(p.likesCount), comments: num(p.commentsCount),
          views: num(p.videoViewCount), caption: (p.caption || "").slice(0, 140),
          ts: p.timestamp, url: p.url,
        }));
        out.push({
          domain: h.domain, name: h.name, platform: "instagram",
          followers, following: num(it.followsCount), post_count: num(it.postsCount),
          verified: !!it.verified, ...summarize(recent, followers), raw: it,
        });
      }
      return out;
    },
  },

  tiktok: {
    actor: "clockworks/tiktok-profile-scraper",
    buildInput: (handles) => ({
      profiles: handles.map((h) => h.handle),
      resultsPerPage: 10,
      shouldDownloadVideos: false, shouldDownloadCovers: false,
      shouldDownloadSubtitles: false, shouldDownloadAvatars: false,
    }),
    normalize: (items, handles) => {
      const out = [];
      // items are videos; profile data lives in authorMeta
      for (const h of handles) {
        const group = items.filter((x) => x.authorMeta && norm(x.authorMeta.name) === norm(h.handle));
        if (!group.length) continue;
        const a = group[0].authorMeta;
        const followers = num(a.fans);
        const recent = group.map((p) => ({
          type: "video", likes: num(p.diggCount), comments: num(p.commentCount),
          views: num(p.playCount), shares: num(p.shareCount),
          caption: (p.text || "").slice(0, 140), ts: p.createTimeISO, url: p.webVideoUrl,
        }));
        out.push({
          domain: h.domain, name: h.name, platform: "tiktok",
          followers, following: num(a.following), post_count: num(a.video),
          verified: !!a.verified, ...summarize(recent, followers), raw: a,
        });
      }
      return out;
    },
  },

  youtube: {
    actor: "streamers/youtube-channel-scraper",
    buildInput: (handles) => ({
      startUrls: handles.map((h) => ({ url: h.handle })),
      maxResults: 8, maxResultsShorts: 0, maxResultStreams: 0, sortVideosBy: "NEWEST",
    }),
    normalize: (items, handles) => {
      const out = [];
      // items are videos carrying channel-level meta; group by channel, match by token in URL/name
      const tokenOf = (url) => {
        const m = String(url || "");
        if (m.includes("/@")) return norm(m.split("/@")[1].split(/[/?]/)[0]);
        if (m.includes("/channel/")) return norm(m.split("/channel/")[1].split(/[/?]/)[0]);
        if (m.includes("/c/")) return norm(m.split("/c/")[1].split(/[/?]/)[0]);
        if (m.includes("/user/")) return norm(m.split("/user/")[1].split(/[/?]/)[0]);
        const seg = m.split("/").filter(Boolean).pop();
        return norm(seg);
      };
      for (const h of handles) {
        const want = tokenOf(h.handle);
        const group = items.filter((x) => {
          const cand = [x.channelUrl, x.channelId, x.channelUsername, x.channelHandle, x.channelName]
            .map((c) => norm(c));
          return cand.some((c) => c && (c === want || c.includes(want) || want.includes(c)));
        });
        if (!group.length) continue;
        const c0 = group[0];
        const followers = num(c0.numberOfSubscribers ?? c0.channelSubscriberCount ?? c0.subscriberCount);
        const recent = group.map((v) => ({
          type: "video", likes: num(v.likes ?? v.likeCount), comments: num(v.commentsCount ?? v.commentCount),
          views: num(v.viewCount ?? v.views), caption: (v.title || "").slice(0, 140),
          ts: v.date ?? v.uploadDate ?? v.publishedAt, url: v.url ?? v.videoUrl,
        }));
        out.push({
          domain: h.domain, name: h.name, platform: "youtube",
          followers, following: null,
          post_count: num(c0.channelTotalVideos ?? c0.numberOfVideos ?? c0.videosCount),
          verified: !!(c0.isChannelVerified ?? c0.channelVerified),
          ...summarize(recent, followers), raw: { channelName: c0.channelName, channelUrl: c0.channelUrl, channelTotalViews: c0.channelTotalViews, numberOfSubscribers: c0.numberOfSubscribers, channelTotalVideos: c0.channelTotalVideos },
        });
      }
      return out;
    },
  },

  linkedin: {
    actor: "automation-lab/linkedin-company-scraper",
    buildInput: (handles) => ({
      companyUrls: handles.map((h) => h.handle),
      startUrls: handles.map((h) => ({ url: h.handle })),
    }),
    normalize: (items, handles) => {
      const out = [];
      const slugOf = (url) => norm(String(url || "").split("/company/")[1]?.split(/[/?]/)[0]);
      for (const h of handles) {
        const want = slugOf(h.handle);
        const it = items.find((x) => {
          const cand = [x.url, x.companyUrl, x.linkedinUrl, x.universalName, x.publicIdentifier]
            .map((c) => (String(c || "").includes("/company/") ? slugOf(c) : norm(c)));
          return cand.some((c) => c && (c === want || c.includes(want) || want.includes(c)));
        });
        if (!it) continue;
        const followers = num(it.followerCount ?? it.followers ?? it.followersCount);
        out.push({
          domain: h.domain, name: h.name, platform: "linkedin",
          followers, following: null,
          post_count: null, verified: false,
          avg_likes: null, avg_comments: null, avg_views: null, engagement_rate: null,
          posts_sampled: 0, newest_post_at: null, recent_posts: [],
          raw: {
            name: it.name, industry: it.industry,
            employeeCount: it.employeeCount ?? it.employees ?? it.companySize,
            followerCount: followers, url: it.url ?? it.companyUrl,
          },
        });
      }
      return out;
    },
  },
};

module.exports = { PLATFORMS };
