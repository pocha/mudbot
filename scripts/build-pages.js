#!/usr/bin/env node
"use strict";

/**
 * build-pages.js
 *
 * Expands the HTML page templates in views/pages/*.html into the static
 * files served from public/. Templates may:
 *
 *   - Declare per-page variables at the top of the file with:
 *       <!--#var key="value"-->
 *     (one per line; stripped from the output).
 *
 *   - Pull in a shared fragment from views/partials/<name>.html with:
 *       <!--#include partial="name"-->
 *     Includes are resolved recursively, so a partial may itself include
 *     another partial.
 *
 *   - Reference variables anywhere in the template (or in an included
 *     partial) with `{{key}}` tokens. Variables are page-scoped: each
 *     page's own <!--#var--> declarations are substituted into everything
 *     that page pulls in.
 *
 * Output mapping (views/pages/<name>.html -> public/<path>):
 *   index.html                -> index.html
 *   dashboard-index.html      -> dashboard/index.html
 *   dashboard-schedules.html  -> dashboard/schedules.html
 *   dashboard-faqs.html       -> dashboard/faqs.html
 *   dashboard-calendly.html   -> dashboard/calendly.html
 *   free-whatsapp-recurring-messages.html    -> free-whatsapp-recurring-messages.html
 *   free-calendly-whatsapp-integration.html  -> free-calendly-whatsapp-integration.html
 *
 * The mapping is data-driven (see PAGE_MAP below) rather than inferred from
 * the filename, so new pages must be added explicitly.
 *
 * No templating engine, no npm dependencies - just string substitution.
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const PAGES_DIR = path.join(ROOT_DIR, "views", "pages");
const PARTIALS_DIR = path.join(ROOT_DIR, "views", "partials");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

// views/pages/<key> -> public/<value>
const PAGE_MAP = {
  "index.html": "index.html",
  "dashboard-index.html": "dashboard/index.html",
  "dashboard-schedules.html": "dashboard/schedules.html",
  "dashboard-faqs.html": "dashboard/faqs.html",
  "dashboard-calendly.html": "dashboard/calendly.html",
  "dashboard-leads.html": "dashboard/leads.html",
  "free-whatsapp-recurring-messages.html":
    "free-whatsapp-recurring-messages.html",
  "free-calendly-whatsapp-integration.html":
    "free-calendly-whatsapp-integration.html",
  "comparison/alternative-to-greenapi.html":
    "comparison/alternative-to-greenapi.html",
  "comparison/alternative-to-waha.html":
    "comparison/alternative-to-waha.html",
  "comparison/alternative-to-evolution-api.html":
    "comparison/alternative-to-evolution-api.html",
  "comparison/alternative-to-openwa.html":
    "comparison/alternative-to-openwa.html",
  "comparison/alternative-to-wasender.html":
    "comparison/alternative-to-wasender.html",
  "comparison/alternative-to-wassenger.html":
    "comparison/alternative-to-wassenger.html",
  "comparison/alternative-to-periskope.html":
    "comparison/alternative-to-periskope.html",
  "comparison/alternative-to-wacli.html":
    "comparison/alternative-to-wacli.html",
  "comparison/alternative-to-whatsapp-business-api.html":
    "comparison/alternative-to-whatsapp-business-api.html",
  "comparison/alternative-to-twilio.html":
    "comparison/alternative-to-twilio.html",
  "comparison/alternative-to-msg91.html":
    "comparison/alternative-to-msg91.html",
  "comparison/alternative-to-gallabox.html":
    "comparison/alternative-to-gallabox.html",
  "comparison/how-to-choose-whatsapp-api-provider.html":
    "comparison/how-to-choose-whatsapp-api-provider.html",
};

const VAR_RE = /^<!--#var\s+([a-zA-Z0-9_]+)="([^"]*)"-->\n?/;
const INCLUDE_RE = /<!--#include\s+partial="([a-zA-Z0-9_-]+)"-->/g;

function readPartial(name) {
  const file = path.join(PARTIALS_DIR, `${name}.html`);
  if (!fs.existsSync(file)) {
    throw new Error(`Partial not found: ${name} (looked in ${file})`);
  }
  const raw = fs.readFileSync(file, "utf8");
  // The include marker sits on its own line in the page template, so its
  // line terminator already supplies the newline after the inlined
  // content. Strip exactly one trailing newline from the partial file so
  // we don't end up with a doubled blank line at the splice point.
  return raw.replace(/\r?\n$/, "");
}

// Resolve <!--#include partial="x"--> markers recursively.
function resolveIncludes(content, seen) {
  let result = content;
  let guard = 0;
  while (INCLUDE_RE.test(result)) {
    INCLUDE_RE.lastIndex = 0;
    result = result.replace(INCLUDE_RE, (match, name) => {
      if (seen.has(name)) {
        throw new Error(`Circular include detected for partial "${name}"`);
      }
      const nextSeen = new Set(seen);
      nextSeen.add(name);
      return resolveIncludes(readPartial(name), nextSeen);
    });
    guard += 1;
    if (guard > 50) {
      throw new Error("Include resolution did not terminate (possible cycle)");
    }
  }
  return result;
}

// Strip leading <!--#var key="value"--> declarations and return {vars, rest}.
function extractVars(content) {
  const vars = {};
  let rest = content;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = rest.match(VAR_RE))) {
    vars[match[1]] = match[2];
    rest = rest.slice(match[0].length);
  }
  return { vars, rest };
}

// Only substitutes tokens that match a declared #var key. Any other
// `{{...}}` occurrence (e.g. literal Calendly message placeholders like
// `{{name}}` that appear in page content) is left untouched.
function substitutePlaceholders(content, vars) {
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      return match;
    }
    return vars[key];
  });
}

function buildPage(pageFile) {
  const srcPath = path.join(PAGES_DIR, pageFile);
  const raw = fs.readFileSync(srcPath, "utf8");
  const { vars, rest } = extractVars(raw);
  const withIncludes = resolveIncludes(rest, new Set());
  const finalHtml = substitutePlaceholders(withIncludes, vars);

  const outRelPath = PAGE_MAP[pageFile];
  if (!outRelPath) {
    throw new Error(
      `No output mapping for ${pageFile}; add it to PAGE_MAP in build-pages.js`
    );
  }
  const outPath = path.join(PUBLIC_DIR, outRelPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, finalHtml, "utf8");
  return outRelPath;
}

function main() {
  const pageFiles = Object.keys(PAGE_MAP);
  const written = [];
  for (const pageFile of pageFiles) {
    const srcPath = path.join(PAGES_DIR, pageFile);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing page template: ${srcPath}`);
    }
    written.push(buildPage(pageFile));
  }
  for (const rel of written) {
    console.log(`built public/${rel}`);
  }
}

main();
