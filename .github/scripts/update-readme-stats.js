// Refreshes the live GitHub stats block inside README.md.
// Runs under actions/github-script with the default GITHUB_TOKEN — no PAT required,
// since every field here is public data about the account owner.

const README_PATH = "README.md";
const USERNAME = "gautamgareja";

function replaceBetween(content, startMarker, endMarker, replacement) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Markers ${startMarker} / ${endMarker} not found in ${README_PATH}`);
  }
  const before = content.slice(0, start + startMarker.length);
  const after = content.slice(end);
  return `${before}${replacement}${after}`;
}

function formatUptime(createdAt) {
  const created = new Date(createdAt);
  const now = new Date();
  let months = (now.getFullYear() - created.getFullYear()) * 12 + (now.getMonth() - created.getMonth());
  if (now.getDate() < created.getDate()) months -= 1;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const parts = [];
  if (years > 0) parts.push(`${years}y`);
  parts.push(`${remMonths}m`);
  return `${parts.join(" ")} (GitHub since ${created.getFullYear()})`;
}

module.exports = async ({ github, core, fs }) => {
  const fsMod = fs || require("fs");

  // 1. Paginate the user's owned, non-fork public repos: name, stars, top languages.
  let repos = [];
  let after = null;
  for (;;) {
    const query = `
      query ($login: String!, $after: String) {
        user(login: $login) {
          createdAt
          followers { totalCount }
          repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, after: $after) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name } }
              }
            }
          }
        }
      }
    `;
    const data = await github.graphql(query, { login: USERNAME, after });
    const userNode = data.user;
    repos = repos.concat(userNode.repositories.nodes);
    if (userNode.repositories.pageInfo.hasNextPage) {
      after = userNode.repositories.pageInfo.endCursor;
    } else {
      var totalRepos = userNode.repositories.totalCount;
      var followers = userNode.followers.totalCount;
      var createdAt = userNode.createdAt;
      break;
    }
  }

  const totalStars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);

  const languageBytes = {};
  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      languageBytes[edge.node.name] = (languageBytes[edge.node.name] || 0) + edge.size;
    }
  }
  const topLanguages = Object.entries(languageBytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  // 2. Commits: sum totalCommitContributions across every year of account history.
  const createdYear = new Date(createdAt).getFullYear();
  const currentYear = new Date().getFullYear();
  let totalCommits = 0;
  for (let year = createdYear; year <= currentYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = `${year + 1}-01-01T00:00:00Z`;
    const query = `
      query ($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
          }
        }
      }
    `;
    try {
      const data = await github.graphql(query, { login: USERNAME, from, to });
      totalCommits += data.user.contributionsCollection.totalCommitContributions;
    } catch (err) {
      core.warning(`Contribution query failed for ${year}: ${err.message}`);
    }
  }

  // 3. Lines of code: sum additions/deletions from the contributor-stats endpoint
  //    across owned public repos. GitHub can return 202 while it warms the cache;
  //    retry a few times, otherwise skip that repo for this run.
  let additions = 0;
  let deletions = 0;
  for (const repo of repos) {
    let stats = null;
    for (let attempt = 0; attempt < 3 && stats === null; attempt++) {
      const res = await github.rest.repos.getContributorsStats({
        owner: USERNAME,
        repo: repo.name,
      });
      if (res.status === 202) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      stats = res.data || [];
    }
    if (!stats) {
      core.warning(`Stats not ready for ${repo.name}, skipping in this run`);
      continue;
    }
    const mine = stats.find((c) => c.author && c.author.login === USERNAME);
    if (mine) {
      for (const week of mine.weeks) {
        additions += week.a;
        deletions += week.d;
      }
    }
  }

  const fmt = (n) => n.toLocaleString("en-US");

  const statsBlock = [
    `Repos      : ${fmt(totalRepos)} (public, owned)`,
    `Stars      : ${fmt(totalStars)}`,
    `Commits    : ${fmt(totalCommits)} (public, all-time)`,
    `Followers  : ${fmt(followers)}`,
    `Lines      : +${fmt(additions)} / -${fmt(deletions)} (all-time, public repos)`,
  ].join("\n");

  let content = fsMod.readFileSync(README_PATH, "utf8");
  content = replaceBetween(content, "<!--GH-STATS:START-->", "<!--GH-STATS:END-->", `\n${statsBlock}\n`);
  content = replaceBetween(
    content,
    "<!--GH-UPTIME:START-->",
    "<!--GH-UPTIME:END-->",
    formatUptime(createdAt)
  );
  content = replaceBetween(
    content,
    "<!--GH-LANGS:START-->",
    "<!--GH-LANGS:END-->",
    topLanguages.join(", ") || "pending (repo stats still indexing)"
  );
  fsMod.writeFileSync(README_PATH, content);

  core.info("README stats refreshed successfully.");
};
