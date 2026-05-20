import { readFile, writeFile } from "node:fs/promises";

const README_PATH = process.env.README_PATH || "README.md";
const AUTHOR =
  process.env.GITHUB_USERNAME ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "SiyuanSun0736";
const LIMIT = Number(process.env.PR_LIST_LIMIT || "6");
const START_MARKER = "<!-- PR-LIST:START -->";
const END_MARKER = "<!-- PR-LIST:END -->";

function getStatus(pr) {
  if (pr.merged) {
    return { icon: "✅", label: "Merged" };
  }

  if (pr.state === "OPEN") {
    return { icon: "🟡", label: "Open" };
  }

  return { icon: "⚪", label: "Closed" };
}

function formatPullRequests(pullRequests) {
  if (!pullRequests.length) {
    return "- 💤 No public pull requests found yet.";
  }

  return pullRequests
    .map((pr) => {
      const { icon, label } = getStatus(pr);
      const updatedAt = new Date(pr.updatedAt).toISOString().slice(0, 10);

      return `- ${icon} [${pr.repository.nameWithOwner}#${pr.number}](${pr.url}) - ${pr.title} (${label}, updated ${updatedAt})`;
    })
    .join("\n");
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `${AUTHOR}-profile-readme`,
      ...init.headers,
    },
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function fetchPullRequestsWithGraphql(token) {
  const payload = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        query($searchQuery: String!, $first: Int!) {
          search(query: $searchQuery, type: ISSUE, first: $first) {
            nodes {
              ... on PullRequest {
                title
                url
                state
                merged
                updatedAt
                number
                repository {
                  nameWithOwner
                }
              }
            }
          }
        }
      `,
      variables: {
        searchQuery: `is:pr author:${AUTHOR} is:public archived:false sort:updated-desc`,
        first: LIMIT,
      },
    }),
  });

  if (payload.errors) {
    throw new Error(
      `GitHub GraphQL request failed: ${JSON.stringify(payload.errors || payload)}`,
    );
  }

  return payload.data.search.nodes;
}

async function fetchPullRequestsWithRest() {
  const searchUrl = new URL("https://api.github.com/search/issues");
  searchUrl.searchParams.set(
    "q",
    `is:pr author:${AUTHOR} is:public archived:false`,
  );
  searchUrl.searchParams.set("sort", "updated");
  searchUrl.searchParams.set("order", "desc");
  searchUrl.searchParams.set("per_page", String(LIMIT));

  const payload = await requestJson(searchUrl);

  return Promise.all(
    payload.items.map(async (item) => {
      let merged = false;

      if (item.state === "closed" && item.pull_request?.url) {
        try {
          const prPayload = await requestJson(item.pull_request.url);
          merged = Boolean(prPayload.merged_at);
        } catch (error) {
          console.warn(`Unable to resolve merge state for ${item.html_url}: ${error.message}`);
        }
      }

      return {
        title: item.title,
        url: item.html_url,
        state: item.state === "open" ? "OPEN" : "CLOSED",
        merged,
        updatedAt: item.updated_at,
        number: item.number,
        repository: {
          nameWithOwner: item.repository_url.replace(
            "https://api.github.com/repos/",
            "",
          ),
        },
      };
    }),
  );
}

async function fetchPullRequests() {
  if (process.env.MOCK_PR_LIST) {
    return JSON.parse(process.env.MOCK_PR_LIST);
  }

  const token = process.env.GITHUB_TOKEN;

  if (token) {
    return fetchPullRequestsWithGraphql(token);
  }

  return fetchPullRequestsWithRest();
}

async function updateReadme() {
  const readme = await readFile(README_PATH, "utf8");
  const startIndex = readme.indexOf(START_MARKER);
  const endIndex = readme.indexOf(END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`README markers not found in ${README_PATH}`);
  }

  const pullRequests = await fetchPullRequests();
  const formattedList = formatPullRequests(pullRequests);
  const before = readme.slice(0, startIndex + START_MARKER.length);
  const after = readme.slice(endIndex);
  const nextReadme = `${before}\n${formattedList}\n${after}`;

  if (process.env.DRY_RUN === "1") {
    console.log(formattedList);
    return;
  }

  await writeFile(README_PATH, nextReadme);
  console.log(`Updated PR list for ${AUTHOR} in ${README_PATH}`);
}

await updateReadme();