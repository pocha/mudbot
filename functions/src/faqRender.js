// Shared FAQ HTML rendering — used both by getFaqStatus (preview fragment,
// shown inside faq.html's result card) and by publishFaq (full static page
// committed to the repo), so the published page always matches what the user
// previewed and edited.

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

function renderFaqEntriesHtml(faq) {
  const sorted = [...faq].sort((a, b) => {
    const countDiff = (b.count || 0) - (a.count || 0);
    if (countDiff !== 0) return countDiff;
    return looseDateValue(b.mostRecentDate) - looseDateValue(a.mostRecentDate);
  });

  return sorted
    .map(({ question, count, mostRecentDate, answers = [] }) => {
      const [latest, ...older] = answers;
      const olderHtml = older.length
        ? `
  <details class="mt-2 pl-6">
    <summary class="cursor-pointer font-label-md text-label-md text-primary font-bold">See ${older.length} earlier answer${older.length > 1 ? 's' : ''}</summary>
    <div class="mt-2 space-y-2">
      ${older.map(a => `<p class="font-body-md text-on-surface-variant"><span class="text-xs opacity-70">${escapeHtml(a.date)}</span> — ${escapeHtml(a.text)}</p>`).join('\n      ')}
    </div>
  </details>`
        : '';

      return `
<div class="pb-5 mb-5 border-b border-outline-variant last:border-b-0 last:mb-0 last:pb-0">
  <h3 class="flex gap-2 font-headline-md text-body-lg font-bold text-on-surface">
    <span class="text-primary shrink-0">Q.</span> ${escapeHtml(question)}
  </h3>
  <p class="mt-2 pl-6 font-body-md text-on-surface-variant">${escapeHtml(latest ? latest.text : '')}</p>
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

<header class="flex justify-between items-center w-full px-gutter py-2 sticky top-0 z-50 bg-surface dark:bg-inverse-surface border-b border-outline-variant dark:border-on-surface-variant shadow-sm h-16">
  <div class="flex items-center gap-4">
    <a href="/" class="font-headline-md text-headline-md font-bold"><span class="text-primary">Wato</span><span class="text-on-surface">Bot</span></a>
  </div>
  <div class="flex items-center gap-4">
    <a href="/whatsapp-group-faq" class="font-label-md text-label-md bg-primary-container text-on-primary-container px-4 py-2 rounded-xl font-bold hover:opacity-90 active:scale-95 transition-all">Create your own FAQ</a>
  </div>
</header>

<main class="flex-1 w-full max-w-2xl mx-auto px-gutter py-12">
  <div class="mb-8">
    <h1 class="font-headline-lg text-headline-lg text-on-surface">${title}</h1>
  </div>

  <div class="bg-surface-container-lowest rounded-xl border border-outline-variant shadow-sm overflow-hidden">
    <div class="p-6">
${entriesHtml}
    </div>
  </div>
</main>

<div id="site-footer"></div>
<script src="/assets/footer.js"></script>
</body>
</html>
`;
}

module.exports = { escapeHtml, looseDateValue, renderFaqEntriesHtml, renderFaqPage };
