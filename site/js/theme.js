// Light/dark toggle. Follows the OS until the visitor picks one; the choice is remembered.
export function initTheme() {
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  const current = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const label = () => { button.textContent = current() === 'dark' ? 'Light theme' : 'Dark theme'; };
  label();
  button.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage blocked */ }
    label();
  });
}
