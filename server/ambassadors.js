// The Twitch Ambassadors team (twitch.tv/team/ambassadors), read from Twitch's
// own data and saved as a list of logins in assets/ambassadors.txt. The panel
// uses the list to tick the Ambassador box automatically. The helper refreshes
// it every few days; `node server/ambassadors.js` refreshes it right now.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "assets", "ambassadors.txt");
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const PAGE = 100;

async function gql(query) {
  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Twitch said " + res.status);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

async function fetchAmbassadorLogins() {
  const logins = [];
  let total = null;
  for (let guard = 0; guard < 20; guard++) {
    // Twitch pages by offset: the cursor is just {"v":1,"o":<how many to skip>}.
    const after = logins.length ? `, after: ${JSON.stringify(Buffer.from(JSON.stringify({ v: 1, o: logins.length })).toString("base64"))}` : "";
    const data = await gql(`{ team(name: "ambassadors") { members(first: ${PAGE}${after}) { totalCount edges { node { login } } pageInfo { hasNextPage } } } }`);
    const members = data.team.members;
    total = members.totalCount;
    for (const e of members.edges) logins.push(String(e.node.login).toLowerCase());
    if (!members.pageInfo.hasNextPage || !members.edges.length) break;
  }
  const unique = [...new Set(logins)];
  if (total && unique.length < total * 0.9) throw new Error(`only got ${unique.length} of ${total} ambassadors`);
  return unique.sort();
}

async function updateAmbassadorFile() {
  const logins = await fetchAmbassadorLogins();
  const header = [
    "# Twitch Ambassador channels, one login (lowercase) per line.",
    "# The panel ticks the Ambassador box automatically for any streamer listed here.",
    "# Source: twitch.tv/team/ambassadors (refreshed automatically by the helper). Lines starting with # are ignored.",
    `# Updated ${new Date().toISOString().slice(0, 10)} - ${logins.length} channels`,
  ];
  fs.writeFileSync(FILE, header.join("\n") + "\n" + logins.join("\n") + "\n");
  return logins.length;
}

function listIsStale() {
  try {
    return Date.now() - fs.statSync(FILE).mtimeMs > STALE_AFTER_MS;
  } catch (e) {
    return true;
  }
}

let refreshing = false;
// Fire and forget: a failed refresh just leaves the old list in place.
function refreshIfStale(log) {
  if (refreshing || !listIsStale()) return;
  refreshing = true;
  updateAmbassadorFile()
    .then((n) => log && log(`Updated the Ambassador list (${n} channels).`))
    .catch((e) => log && log("Couldn't update the Ambassador list: " + e.message))
    .finally(() => (refreshing = false));
}

module.exports = { updateAmbassadorFile, refreshIfStale, FILE };

if (require.main === module) {
  updateAmbassadorFile().then((n) => console.log(`Saved ${n} Ambassador channels to ${FILE}`), (e) => {
    console.error("Failed:", e.message);
    process.exit(1);
  });
}
