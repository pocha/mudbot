// Shared FAQ HTML rendering — used both by getFaqStatus (preview fragment,
// shown inside faq.html's result card) and by publishFaq (full static page
// committed to the repo), so the published page always matches what the user
// previewed and edited.

const crypto = require('crypto');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Best-effort only — WhatsApp export date formats vary and aren't reliably
// parseable, so this is used purely as a secondary tie-break under count,
// never surfaced as a guaranteed-accurate value.
function looseDateValue(str) {
  const t = Date.parse(str);
  return Number.isNaN(t) ? 0 : t;
}

const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

// Escapes text but turns any bare URLs within it into real links. Splits on
// the URL regex first (capturing group keeps the matches in the output) so
// every segment — link or not — still goes through escapeHtml individually;
// safe against XSS the same way plain escapeHtml usage was.
function linkify(rawText) {
  return String(rawText)
    .split(URL_REGEX)
    .map((part, i) => {
      if (i % 2 === 0) return escapeHtml(part);
      // Strip common trailing punctuation a URL likely isn't actually part
      // of (e.g. "see https://example.com." shouldn't swallow the period).
      const trailingMatch = part.match(TRAILING_PUNCT);
      const trailing = trailingMatch ? trailingMatch[0] : '';
      const url = trailing ? part.slice(0, -trailing.length) : part;
      const href = escapeHtml(url);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-primary underline break-all">${href}</a>${escapeHtml(trailing)}`;
    })
    .join('');
}

// Deterministic per-question anchor id, stable across regenerations (so a
// previously shared link keeps working after a republish) as long as the
// question's wording itself doesn't change — which is the right invariant,
// since a link to "the entry about X" legitimately has nothing to point at
// once X's wording is gone. Hash suffix (not positional index) avoids two
// different entries colliding if their slugs are both empty/similar, and
// avoids link breakage from entries merely being reordered by count.
function entryId(question) {
  const slug = String(question)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const hash = crypto.createHash('sha256').update(question).digest('hex').slice(0, 6);
  return `faq-${slug || 'q'}-${hash}`;
}

function renderFaqEntriesHtml(faq) {
  const sorted = [...faq].sort((a, b) => {
    const countDiff = (b.count || 0) - (a.count || 0);
    if (countDiff !== 0) return countDiff;
    return looseDateValue(b.mostRecentDate) - looseDateValue(a.mostRecentDate);
  });

  return sorted
    .map(({ question, count, mostRecentDate, answers = [] }) => {
      const [latest, ...older] = answers;
      const id = entryId(question);
      const searchText = escapeHtml([question, ...answers.map(a => a.text)].join(' ').toLowerCase());
      const olderHtml = older.length
        ? `
  <details class="mt-2 pl-6">
    <summary class="cursor-pointer font-label-md text-label-md text-primary font-bold">See ${older.length} earlier answer${older.length > 1 ? 's' : ''}</summary>
    <div class="mt-2 space-y-2">
      ${older.map(a => `<p class="font-body-md text-on-surface-variant"><span class="text-xs opacity-70">${escapeHtml(a.date)}</span> — ${linkify(a.text)}</p>`).join('\n      ')}
    </div>
  </details>`
        : '';

      return `
<div class="faq-entry pb-5 mb-5 border-b border-outline-variant last:border-b-0 last:mb-0 last:pb-0" id="${id}" data-search="${searchText}">
  <div class="flex items-start justify-between gap-2">
    <h3 class="flex gap-2 font-headline-md text-body-lg font-bold text-on-surface">
      <span class="text-primary shrink-0">Q.</span> ${linkify(question)}
    </h3>
    <div class="relative shrink-0">
      <button type="button" class="faq-share-btn inline-flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors font-label-md text-sm" data-share-id="${id}" data-share-question="${escapeHtml(question)}">
        <span class="material-symbols-outlined text-[18px]">share</span> Share
      </button>
      <div class="faq-share-menu hidden absolute right-0 mt-1 w-48 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg z-10 overflow-hidden">
        <a class="faq-share-whatsapp flex items-center gap-2 px-4 py-2 text-sm text-on-surface hover:bg-surface-container-low" target="_blank" rel="noopener" href="#">
          <span class="material-symbols-outlined text-[18px]">chat</span> Share on WhatsApp
        </a>
        <button type="button" class="faq-share-copy flex items-center gap-2 w-full text-left px-4 py-2 text-sm text-on-surface hover:bg-surface-container-low">
          <span class="material-symbols-outlined text-[18px]">content_copy</span> Copy link
        </button>
      </div>
    </div>
  </div>
  <p class="mt-2 pl-6 font-body-md text-on-surface-variant">${linkify(latest ? latest.text : '')}</p>
  <p class="mt-1 pl-6 text-xs text-on-surface-variant opacity-70">Came up ~${count || 1} time${(count || 1) === 1 ? '' : 's'} &middot; last discussed ${escapeHtml(mostRecentDate || '')}</p>${olderHtml}
</div>`.trim();
    })
    .join('\n');
}

// Full standalone page, committed as a static file to the repo and served
// by GitHub Pages. Deliberately no upload form / JS state — this is the
// published, read-only view; editing happens on whatsapp-group-faq/index.html
// before publish.
function renderFaqPage(groupName, faq) {
  const title = `FAQ for ${escapeHtml(groupName)}`;
  const entriesHtml = renderFaqEntriesHtml(faq);

  return `<!DOCTYPE html>
<html class="light" lang="en">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>${title} — Watobot</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script src="/assets/theme.js"></script>
<link rel="stylesheet" href="/assets/theme.css"/>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col">

<!-- Single sticky header (was two stacked sticky bars before — that made
     scrollIntoView's centering land shared-link targets partially behind the
     combined chrome, since it has no awareness of sticky elements eating
     into the visible viewport). Search now lives in the nav itself: a
     permanently visible input on wider screens, a takeover (icon -> full-
     width input) on narrow ones where there isn't room for everything at once. -->
<header class="flex items-center w-full px-gutter py-2 sticky top-0 z-50 bg-surface dark:bg-inverse-surface border-b border-outline-variant dark:border-on-surface-variant shadow-sm h-16">
  <div id="nav-normal" class="flex items-center justify-between w-full gap-3">
    <div class="flex items-center gap-2 shrink-0">
      <button id="nav-search-toggle" type="button" class="md:hidden text-on-surface-variant hover:text-primary transition-colors" title="Search FAQs" aria-label="Search FAQs">
        <span class="material-symbols-outlined">search</span>
      </button>
      <a href="/" class="font-headline-md text-headline-md font-bold whitespace-nowrap"><span class="text-primary">Wato</span><span class="text-on-surface">Bot</span></a>
    </div>

    <div class="hidden md:block relative flex-1 max-w-sm">
      <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant opacity-60 pointer-events-none text-[20px]">search</span>
      <input type="text" placeholder="Search FAQs…" class="faq-search-input w-full pl-9 pr-3 py-1.5 bg-surface-container-low border border-outline-variant rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all text-sm" />
    </div>

    <a href="/whatsapp-group-faq" class="font-label-md text-label-md bg-primary-container text-on-primary-container px-4 py-2 rounded-xl font-bold hover:opacity-90 active:scale-95 transition-all whitespace-nowrap shrink-0">Create your own FAQ</a>
  </div>

  <div id="nav-search-mobile" class="hidden items-center gap-2 w-full">
    <span class="material-symbols-outlined text-on-surface-variant text-[20px] shrink-0">search</span>
    <input type="text" placeholder="Search FAQs…" class="faq-search-input flex-1 min-w-0 bg-transparent outline-none text-sm" />
    <button id="nav-search-close" type="button" class="text-on-surface-variant hover:text-error transition-colors shrink-0" title="Close search" aria-label="Close search">
      <span class="material-symbols-outlined">close</span>
    </button>
  </div>
</header>

<main class="flex-1 w-full max-w-2xl mx-auto px-gutter py-12">
  <div class="mb-8">
    <h1 class="font-headline-lg text-headline-lg text-on-surface">${title}</h1>
  </div>

  <div class="bg-surface-container-lowest rounded-xl border border-outline-variant shadow-sm overflow-hidden">
    <div class="p-6" id="faq-list">
${entriesHtml}
    </div>
    <p id="faq-no-results" class="hidden p-6 text-center text-on-surface-variant font-body-md text-sm">No matching questions found.</p>
  </div>
</main>

<div id="site-footer"></div>
<script src="/assets/footer.js"></script>
<script>
(function () {
  const entries = Array.from(document.querySelectorAll('.faq-entry'));
  const noResults = document.getElementById('faq-no-results');
  // Two inputs (desktop-permanent, mobile-takeover) — only one is ever
  // visible at a time, but kept in sync regardless so a resize mid-search
  // (or just generally) doesn't lose or fork what was typed.
  const searchInputs = Array.from(document.querySelectorAll('.faq-search-input'));

  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    let visibleCount = 0;
    entries.forEach(el => {
      const matches = !q || (el.dataset.search || '').includes(q);
      el.classList.toggle('hidden', !matches);
      if (matches) visibleCount++;
    });
    noResults.classList.toggle('hidden', visibleCount > 0);
  }

  searchInputs.forEach(input => {
    input.addEventListener('input', () => {
      searchInputs.forEach(other => { if (other !== input) other.value = input.value; });
      applyFilter(input.value);
    });
  });

  const navNormal = document.getElementById('nav-normal');
  const navSearchMobile = document.getElementById('nav-search-mobile');
  const searchToggle = document.getElementById('nav-search-toggle');
  const searchClose = document.getElementById('nav-search-close');
  const mobileInput = navSearchMobile.querySelector('.faq-search-input');

  searchToggle.addEventListener('click', () => {
    navNormal.classList.add('hidden');
    navSearchMobile.classList.remove('hidden');
    navSearchMobile.classList.add('flex');
    mobileInput.focus();
  });

  searchClose.addEventListener('click', () => {
    navSearchMobile.classList.add('hidden');
    navSearchMobile.classList.remove('flex');
    navNormal.classList.remove('hidden');
    navNormal.classList.add('flex');
    if (mobileInput.value) {
      mobileInput.value = '';
      searchInputs.forEach(other => { other.value = ''; });
      applyFilter('');
    }
  });

  document.querySelectorAll('.faq-share-btn').forEach(btn => {
    const url = \`\${location.origin}\${location.pathname}#\${btn.dataset.shareId}\`;
    const question = btn.dataset.shareQuestion || '';
    const menu = btn.nextElementSibling;
    const whatsappLink = menu.querySelector('.faq-share-whatsapp');
    const copyBtn = menu.querySelector('.faq-share-copy');

    whatsappLink.href = \`https://wa.me/?text=\${encodeURIComponent(question + '\\n' + url)}\`;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();

      // Native share sheet when available — this is what actually surfaces
      // WhatsApp (and everything else the OS knows about) without having to
      // hardcode a list of platforms. Falls back to the explicit menu below
      // only on browsers that don't support it (mainly some desktop ones).
      if (navigator.share) {
        try {
          await navigator.share({ title: question, text: question, url });
        } catch (err) {
          // AbortError = user closed the native share sheet — not an error
        }
        return;
      }

      document.querySelectorAll('.faq-share-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    });

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        const label = copyBtn.lastChild;
        const original = label.textContent;
        label.textContent = ' Copied!';
        setTimeout(() => { label.textContent = original; menu.classList.add('hidden'); }, 1000);
      });
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.faq-share-menu').forEach(m => m.classList.add('hidden'));
  });

  // Native anchor-scroll already jumps to a matching #id on load, but this
  // makes it smooth and briefly highlights the entry so a shared link's
  // target is obvious rather than just "the page happened to land here."
  function highlightAndScrollToHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('bg-primary-container/20', 'transition-colors', 'duration-1000', 'rounded-lg', '-mx-2', 'px-2');
    setTimeout(() => el.classList.remove('bg-primary-container/20'), 2000);
  }
  highlightAndScrollToHash();
  window.addEventListener('hashchange', highlightAndScrollToHash);
})();
</script>
</body>
</html>
`;
}

module.exports = { escapeHtml, looseDateValue, renderFaqEntriesHtml, renderFaqPage };
