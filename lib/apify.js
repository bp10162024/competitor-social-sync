// Apify API client — start an actor run, poll to completion, fetch dataset items.
// Node 22 global fetch. Token passed as query param (Apify standard).
const BASE = "https://api.apify.com/v2";
const TOKEN = process.env.APIFY_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run an actor with the given input. Resolves to the array of dataset items.
async function runActor(actorId, input, { pollMs = 5000, maxWaitMs = 270000 } = {}) {
  if (!TOKEN) throw new Error("APIFY_TOKEN not set");
  const actorPath = actorId.replace("/", "~");

  const startRes = await fetch(`${BASE}/acts/${actorPath}/runs?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!startRes.ok) {
    const t = await startRes.text();
    throw new Error(`apify start ${actorId} -> ${startRes.status} ${t.slice(0, 300)}`);
  }
  const start = await startRes.json();
  const runId = start.data?.id;
  const datasetId = start.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error(`apify start ${actorId}: no runId/datasetId`);

  const deadline = Date.now() + maxWaitMs;
  let status = start.data.status;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
    if (Date.now() > deadline) {
      // best-effort abort so we don't leak a long-running run
      try { await fetch(`${BASE}/actor-runs/${runId}/abort?token=${TOKEN}`, { method: "POST" }); } catch (_) {}
      throw new Error(`apify run ${actorId} timed out after ${maxWaitMs}ms (last status ${status})`);
    }
    await sleep(pollMs);
    const r = await fetch(`${BASE}/actor-runs/${runId}?token=${TOKEN}`);
    const j = await r.json();
    status = j.data?.status || status;
  }
  if (status !== "SUCCEEDED") throw new Error(`apify run ${actorId} ended ${status}`);

  const itemsRes = await fetch(`${BASE}/datasets/${datasetId}/items?token=${TOKEN}&clean=true`);
  if (!itemsRes.ok) throw new Error(`apify dataset ${actorId} -> ${itemsRes.status}`);
  return await itemsRes.json();
}

module.exports = { runActor };
