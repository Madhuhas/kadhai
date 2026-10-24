// Apply the saved theme before first paint to avoid a flash. Loaded as a plain (blocking)
// script from the page head; it is a file of its own so the page needs no inline script.
try {
  const saved = localStorage.getItem('kadhai.theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  // No storage (a private window): the default theme is fine.
}
