// Shared site footer. Place <div id="site-footer"></div> where the footer
// should appear and include this script after it. Uses an inline template
// (not fetch) so it also works when a page is opened directly via file://.
(function () {
  const FOOTER_HTML = `
    <footer class="w-full py-8 px-gutter flex flex-col md:flex-row justify-between items-center gap-stack-gap bg-surface-dim dark:bg-inverse-surface border-t border-outline-variant">
      <div class="flex flex-col items-center md:items-start">
        <span class="font-label-md text-label-md font-bold text-on-surface">Watobot Automation</span>
        <p class="text-on-surface-variant text-body-md">&copy; 2024 Watobot Automation. All rights reserved.</p>
      </div>
      <div class="flex gap-6">
        <a class="text-on-surface-variant hover:text-primary transition-opacity hover:opacity-80 underline font-body-md text-body-md" href="/privacy.html">Privacy Policy</a>
        <a class="text-on-surface-variant hover:text-primary transition-opacity hover:opacity-80 underline font-body-md text-body-md" href="https://github.com/pocha/mudbot?tab=readme-ov-file#api" target="_blank" rel="noopener">API Docs</a>
        <button onclick="openSupport()" class="text-on-surface-variant hover:text-primary transition-opacity hover:opacity-80 underline font-body-md text-body-md">Support</button>
      </div>
    </footer>
  `;

  function mount() {
    const el = document.getElementById('site-footer');
    if (el) el.innerHTML = FOOTER_HTML;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
