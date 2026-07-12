#!/usr/bin/env node
// Bulk-regenerates every previously-published FAQ's static HTML file using
// the CURRENT functions/src/faqRender.js template, and re-commits each one
// via the GitHub Contents API. Run this after a faqRender.js design change
// so already-published pages don't stay frozen with the old template forever
// (publishFaq only ever renders once, at the moment a user clicks Publish —
// see the faqRender.js history for why).
//
// Usage:
//   node scripts/regenerate-faqs.js            # dry run: lists what would change, commits nothing
//   node scripts/regenerate-faqs.js --apply    # actually commits each regenerated page
//
// Requires:
//   - Firestore Admin credentials for the wato-bot project: run
//     `gcloud auth application-default login` once, or set
//     GOOGLE_APPLICATION_CREDENTIALS to a service account key with Firestore
//     read access.
//   - GITHUB_TOKEN in functions/.env (same one publishFaq uses in production).

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

// Same minimal .env loader as test/test-prompt.js — no dotenv dependency.
function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const { renderFaqPage } = require('../src/faqRender');
const { publishFile } = require('../src/githubPublish');

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN not set (functions/.env)');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'wato-bot' });
  const db = admin.firestore();

  const snap = await db.collection('faqJobs').get();
  const jobs = snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(job => job.faqSlug && Array.isArray(job.faq) && job.faq.length);

  console.log(`Found ${jobs.length} published FAQ job(s) to regenerate.`);
  if (DRY_RUN) console.log('DRY RUN — no commits will be made. Pass --apply to actually push changes.\n');

  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    const repoPath = `public/whatsapp-group-faq/${job.faqSlug}.html`;
    console.log(`- ${job.faqSlug}  (jobId ${job.id}, group "${job.groupName}")`);

    if (DRY_RUN) continue;

    try {
      const html = renderFaqPage(job.groupName, job.faq);
      await publishFile({
        repoPath,
        content: html,
        message: `Regenerate FAQ: ${job.groupName}`,
        token: process.env.GITHUB_TOKEN
      });
      succeeded++;
      // Small pause between commits — avoids hammering the GitHub API and
      // gives the Pages deploy workflow's concurrency-cancel (deploy-pages.yml)
      // a moment to settle rather than piling up many superseded runs.
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${err.message}`);
    }
  }

  if (!DRY_RUN) {
    console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
  }
}

main().catch(err => {
  console.error('regenerate-faqs failed:', err);
  process.exit(1);
});