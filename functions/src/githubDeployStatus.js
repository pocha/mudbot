// Maps a commit sha to the state of the deploy-pages.yml workflow run it
// triggered, so the frontend can poll until GitHub Pages has actually
// finished deploying before redirecting the user to the published URL
// (rather than guessing based on a fixed delay).

const { GITHUB_OWNER, GITHUB_REPO } = require('./githubPublish');

const GITHUB_API = 'https://api.github.com';
const WORKFLOW_FILE = 'deploy-pages.yml';

async function getDeployStatusForCommit(commitSha, token) {
  const res = await fetch(
    `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${commitSha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );

  if (!res.ok) {
    throw new Error(`GitHub Actions runs lookup failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const data = await res.json();
  const run = data.workflow_runs && data.workflow_runs[0];

  // GitHub Actions can take a few seconds to register a run against a fresh
  // commit — not an error, the frontend just keeps polling.
  if (!run) return { state: 'pending' };
  if (run.status !== 'completed') return { state: 'running' };
  return { state: run.conclusion === 'success' ? 'success' : 'failure' };
}

module.exports = { getDeployStatusForCommit };
