import { h } from './util.js';

/**
 * Brand logos, used in three places only: the keys dialog, the connections
 * dialog and the apps and services on the flows canvas, where telling one service from another at a glance matters. The
 * rest of the app has no pictures.
 *
 * The files in public/logos/ come from Simple Icons (CC0), one path each, and
 * are painted as a mask in the text colour, so they follow the theme and stay
 * monochrome. A service without a logo there shows its short tag instead.
 * To add one: save "<id>.svg" in public/logos/ and add the id below - only an icon that is in the
 * current Simple Icons set, under the brand's own name. Slack (removed from Simple Icons) and
 * Hacker News (only Y Combinator's mark exists) were taken out for that reason and show their tag.
 */
const LOGOS = new Set(["airtable","asana","astro-docs","atlassian","box","brave","calcom","chrome","clickup","cloudflare-docs","cloudflare-observability","discord","dropbox","duckduckgo","email","figma","gemini","github","gitlab","google","hubspot","huggingface","intercom","linear","mapbox","mistral","mongodb","neon","netlify","notion","ntfy","nvidia","openrouter","paypal","posthog","prisma","reddit","rss","sentry","sqlite","square","stripe","supabase","svelte","telegram","todoist","trello","vercel","webflow","wikipedia","wix","youtube","zapier"]);

export function logo(id, tag = '') {
  if (!LOGOS.has(id)) return h('span', { class: 'conn-icon', ariaHidden: 'true' }, tag);
  const el = h('span', { class: 'conn-icon logo', ariaHidden: 'true' });
  el.style.setProperty('--logo', `url("/logos/${id}.svg")`);
  return el;
}
