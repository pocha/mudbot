// Commits FAQ pages directly into the public/whatsapp-groups/ directory of
// the site's own repo via the GitHub Contents API (not git clone+push — one
// HTTP call per file, no local git state to manage from a Cloud Function).
// Pushing to main is what the existing deploy-pages.yml workflow watches
// (path-filtered to public/**), so a successful commit here is what kicks off
// the actual GitHub Pages deploy.

const GITHUB_OWNER = 'pocha';
const GITHUB_REPO = 'mudbot';
const GITHUB_API = 'https://api.github.com';

function ghFetch(path, token, options = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
}

// Creates or updates a file at repoPath. Looks up the current sha first
// (required by the Contents API for updates; absent entirely for a
// brand-new file). Retries once on a 409 (another write raced us and moved
// the sha) by re-fetching the latest sha and reattempting — same pattern as
// the 429 retry in gemini.js, one retry is enough for a low-concurrency path
// like this.
async function publishFile({ repoPath, content, message, token, attempt = 1 }) {
  const getRes = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`, token);

  let sha;
  if (getRes.status === 200) {
    sha = (await getRes.json()).sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET contents failed: ${getRes.status} ${await getRes.text().catch(() => '')}`);
  }

  const putRes = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: 'main',
      ...(sha ? { sha } : {})
    })
  });

  if (putRes.status === 409 && attempt === 1) {
    return publishFile({ repoPath, content, message, token, attempt: 2 });
  }
  if (!putRes.ok) {
    throw new Error(`GitHub PUT contents failed: ${putRes.status} ${await putRes.text().catch(() => '')}`);
  }

  const putData = await putRes.json();
  return { commitSha: putData.commit.sha };
}

module.exports = { publishFile, GITHUB_OWNER, GITHUB_REPO };
