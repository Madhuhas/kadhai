import { CREDENTIAL_TYPES } from '../services.js';

/**
 * The connector catalog: well-known services and tools that can be switched on
 * from the dashboard with one click. Every entry is an MCP server; the catalog
 * only knows how to start it and what to ask the user for.
 *
 * type     how it connects
 *   local    runs on this computer, nothing to sign in to
 *   open     a public service, no account needed
 *   key      needs an API key or token that the user pastes in
 *   signin   the service's own hosted connector: a browser tab opens to sign in
 *            (bridged with the "mcp-remote" helper)
 *   account  built into Kadhai (Google)
 *
 * icon     a two- or three-letter tag; Kadhai shows no pictures or emoji
 *
 * checked  what was verified when the entry was added (October 2026):
 *   'used'    connected through Kadhai and a real tool call answered
 *   'starts'  connected through Kadhai and listed its tools
 *   'live'    the service's address answers and asks for sign-in; the sign-in
 *             itself has not been tried from Kadhai
 *
 * Add an entry only after checking it: package names and addresses were all
 * confirmed against npm and the live endpoints, never taken from memory.
 */
const remote = (url) => ['npx', '-y', 'mcp-remote', url];

export const CATEGORIES = ['Code & docs', 'Work & projects', 'Web & search', 'Data', 'Design & sites', 'Business', 'This computer'];

export const CATALOG = [
  // ------------------------------------------------------------ Code & docs
  { id: 'context7', name: 'Context7', icon: 'C7', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'Up-to-date documentation for any library or framework', run: remote('https://mcp.context7.com/mcp') },
  { id: 'deepwiki', name: 'DeepWiki', icon: 'DW', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'Ask questions about any public GitHub repository', run: remote('https://mcp.deepwiki.com/mcp') },
  { id: 'gitmcp', name: 'GitMCP', icon: 'GM', category: 'Code & docs', type: 'open', checked: 'starts', blurb: 'Read the docs and code of any GitHub project', run: remote('https://gitmcp.io/docs') },
  {
    id: 'github',
    name: 'GitHub',
    icon: 'GH',
    category: 'Code & docs',
    type: 'key',
    checked: 'live',
    blurb: 'Issues, pull requests and code in your repositories',
    run: [...remote('https://api.githubcopilot.com/mcp/'), '--header', 'Authorization:${AUTH_HEADER}'],
    fields: [{ id: 'token', label: 'Personal access token', placeholder: 'github_pat_…', secret: true, env: 'AUTH_HEADER', prefix: 'Bearer ', help: 'https://github.com/settings/personal-access-tokens' }],
    // Checked with GitHub before starting: with a token it refuses, mcp-remote falls back to a browser sign-in.
    verify: 'github',
  },
  { id: 'gitlab', name: 'GitLab', icon: 'GL', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Projects, merge requests and issues on GitLab', run: remote('https://gitlab.com/api/v4/mcp') },
  { id: 'huggingface', name: 'Hugging Face', icon: 'HF', category: 'Code & docs', type: 'open', checked: 'starts', blurb: 'Search models, datasets and Spaces', run: remote('https://huggingface.co/mcp') },
  { id: 'cloudflare-docs', name: 'Cloudflare docs', icon: 'CF', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'Search the Cloudflare developer documentation', run: remote('https://docs.mcp.cloudflare.com/mcp') },
  { id: 'sentry', name: 'Sentry', icon: 'SE', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Errors and issues from your Sentry projects', run: remote('https://mcp.sentry.dev/mcp') },
  { id: 'semgrep', name: 'Semgrep', icon: 'SG', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Scan code for security problems', run: remote('https://mcp.semgrep.ai/mcp') },
  { id: 'vercel', name: 'Vercel', icon: 'VC', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Your Vercel projects and deployments', run: remote('https://mcp.vercel.com') },
  { id: 'microsoft-learn', name: 'Microsoft Learn', icon: 'MS', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'Search and read the official Microsoft and Azure documentation, with code samples', run: remote('https://learn.microsoft.com/api/mcp') },
  { id: 'aws-knowledge', name: 'AWS docs', icon: 'AWS', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'Search and read the AWS documentation, and which services each region has', run: remote('https://knowledge-mcp.global.api.aws') },
  { id: 'svelte', name: 'Svelte docs', icon: 'SV', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'The Svelte and SvelteKit documentation, and a checker for Svelte code', run: remote('https://mcp.svelte.dev/mcp') },
  { id: 'astro-docs', name: 'Astro docs', icon: 'AST', category: 'Code & docs', type: 'open', checked: 'used', blurb: 'Search the Astro documentation', run: remote('https://mcp.docs.astro.build/mcp') },
  { id: 'cloudflare-observability', name: 'Cloudflare logs', icon: 'CFO', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Logs and analytics of your Cloudflare Workers', run: remote('https://observability.mcp.cloudflare.com/mcp') },
  { id: 'globalping', name: 'Globalping', icon: 'GP', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Ping, traceroute and HTTP checks from probes around the world', run: remote('https://mcp.globalping.dev/mcp') },
  { id: 'netlify', name: 'Netlify', icon: 'NF', category: 'Code & docs', type: 'signin', checked: 'live', blurb: 'Your Netlify sites and deploys', run: remote('https://netlify-mcp.netlify.app/mcp') },

  // -------------------------------------------------------- Work & projects
  { id: 'google', name: 'Google', icon: 'G', category: 'Work & projects', type: 'account', checked: 'live', blurb: 'Read your Drive, Docs, Sheets, Gmail and Calendar' },
  { id: 'notion', name: 'Notion', icon: 'NO', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Pages and databases in your Notion workspace', run: remote('https://mcp.notion.com/mcp') },
  { id: 'linear', name: 'Linear', icon: 'LN', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Issues, projects and cycles in Linear', run: remote('https://mcp.linear.app/mcp') },
  { id: 'atlassian', name: 'Jira & Confluence', icon: 'JC', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Atlassian: Jira issues and Confluence pages', run: remote('https://mcp.atlassian.com/v1/sse') },
  { id: 'slack', name: 'Slack', icon: 'SL', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Channels and messages in your Slack workspace', run: remote('https://mcp.slack.com/mcp') },
  { id: 'asana', name: 'Asana', icon: 'AS', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Tasks and projects in Asana', run: remote('https://mcp.asana.com/sse') },
  { id: 'clickup', name: 'ClickUp', icon: 'CU', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Tasks and docs in ClickUp', run: remote('https://mcp.clickup.com/mcp') },
  { id: 'monday', name: 'monday.com', icon: 'MO', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Boards and items on monday.com', run: remote('https://mcp.monday.com/sse') },
  { id: 'airtable', name: 'Airtable', icon: 'AT', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Bases, tables and records in Airtable', run: remote('https://mcp.airtable.com/mcp') },
  { id: 'jam', name: 'Jam', icon: 'JAM', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Bug reports recorded with Jam', run: remote('https://mcp.jam.dev/mcp') },
  { id: 'intercom', name: 'Intercom', icon: 'IC', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Customer conversations in Intercom', run: remote('https://mcp.intercom.com/mcp') },
  { id: 'dropbox', name: 'Dropbox', icon: 'DBX', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Files in your Dropbox', run: remote('https://mcp.dropbox.com/mcp') },
  { id: 'box', name: 'Box', icon: 'BOX', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Files in your Box account', run: remote('https://mcp.box.com') },
  { id: 'todoist', name: 'Todoist', icon: 'TD', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Tasks and projects in Todoist', run: remote('https://ai.todoist.net/mcp') },
  { id: 'calcom', name: 'Cal.com', icon: 'CAL', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Bookings and availability in Cal.com', run: remote('https://mcp.cal.com/mcp') },
  { id: 'zapier', name: 'Zapier', icon: 'ZAP', category: 'Work & projects', type: 'signin', checked: 'live', blurb: 'Thousands of apps through your Zapier account', run: remote('https://mcp.zapier.com/api/mcp/mcp') },

  // ----------------------------------------------------------- Web & search
  { id: 'duckduckgo', name: 'Web search', icon: 'DDG', category: 'Web & search', type: 'local', checked: 'starts', blurb: 'Search the web with DuckDuckGo — no key needed (it may refuse searches that come too fast)', run: ['npx', '-y', 'duckduckgo-mcp-server'] },
  { id: 'exa', name: 'Exa search', icon: 'EXA', category: 'Web & search', type: 'open', checked: 'used', blurb: 'Search the web and fetch pages with Exa', run: remote('https://mcp.exa.ai/mcp') },
  {
    id: 'brave',
    name: 'Brave Search',
    icon: 'BR',
    category: 'Web & search',
    type: 'key',
    checked: 'starts',
    blurb: 'Web, news and image search (free tier available)',
    run: ['npx', '-y', '@brave/brave-search-mcp-server'],
    fields: [{ id: 'key', label: 'Brave Search API key', secret: true, env: 'BRAVE_API_KEY', help: 'https://brave.com/search/api/' }],
  },
  {
    id: 'tavily',
    name: 'Tavily',
    icon: 'TV',
    category: 'Web & search',
    type: 'key',
    checked: 'starts',
    blurb: 'Search, extract and crawl the web (free tier available)',
    run: ['npx', '-y', 'tavily-mcp'],
    fields: [{ id: 'key', label: 'Tavily API key', placeholder: 'tvly-…', secret: true, env: 'TAVILY_API_KEY', help: 'https://app.tavily.com' }],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    icon: 'FC',
    category: 'Web & search',
    type: 'key',
    checked: 'starts',
    blurb: 'Turn any website into clean text',
    run: ['npx', '-y', 'firecrawl-mcp'],
    fields: [{ id: 'key', label: 'Firecrawl API key', placeholder: 'fc-…', secret: true, env: 'FIRECRAWL_API_KEY', help: 'https://www.firecrawl.dev/app/api-keys' }],
  },
  { id: 'fetch', name: 'Fetch a page', icon: 'GET', category: 'Web & search', type: 'local', checked: 'used', blurb: 'Download a web page and read it as text', run: ['npx', '-y', '@kazuph/mcp-fetch'] },
  { id: 'playwright', name: 'Browser', icon: 'PW', category: 'Web & search', type: 'local', checked: 'starts', blurb: 'Drive a real browser: open pages, click, fill forms (Playwright)', run: ['npx', '-y', '@playwright/mcp'] },
  { id: 'chrome', name: 'Chrome DevTools', icon: 'CDT', category: 'Web & search', type: 'local', checked: 'starts', blurb: 'Inspect and debug a page in Chrome: console, network, performance', run: ['npx', '-y', 'chrome-devtools-mcp'] },
  { id: 'youtube', name: 'YouTube', icon: 'YT', category: 'Web & search', type: 'local', checked: 'starts', blurb: 'Read the subtitles of a YouTube video', run: ['npx', '-y', '@anaisbetts/mcp-youtube'] },

  // ------------------------------------------------------------------- Data
  {
    id: 'sqlite',
    name: 'SQLite',
    icon: 'SQL',
    category: 'Data',
    type: 'local',
    checked: 'used',
    blurb: 'Query and change a SQLite database file',
    run: ['npx', '-y', 'mcp-server-sqlite-npx', '{path}'],
    fields: [{ id: 'path', label: 'Database file', placeholder: 'C:/path/to/data.db' }],
  },
  { id: 'supabase', name: 'Supabase', icon: 'SB', category: 'Data', type: 'signin', checked: 'live', blurb: 'Your Supabase projects, tables and SQL', run: remote('https://mcp.supabase.com/mcp') },
  { id: 'neon', name: 'Neon', icon: 'NE', category: 'Data', type: 'signin', checked: 'live', blurb: 'Your Neon Postgres databases', run: remote('https://mcp.neon.tech/mcp') },
  { id: 'excel', name: 'Excel files', icon: 'XLS', category: 'Data', type: 'local', checked: 'starts', blurb: 'Read and write .xlsx spreadsheets on this computer (no Excel needed)', run: ['npx', '-y', '@negokaz/excel-mcp-server'] },
  {
    id: 'mongodb',
    name: 'MongoDB',
    icon: 'MDB',
    category: 'Data',
    type: 'key',
    checked: 'starts',
    blurb: 'Look at a MongoDB database: collections, schemas, queries (read-only)',
    run: ['npx', '-y', 'mongodb-mcp-server', '--readOnly'],
    fields: [{ id: 'uri', label: 'Connection string', placeholder: 'mongodb+srv://user:password@cluster…', secret: true, env: 'MDB_MCP_CONNECTION_STRING', help: 'https://www.mongodb.com/docs/manual/reference/connection-string/' }],
  },
  { id: 'prisma', name: 'Prisma Postgres', icon: 'PR', category: 'Data', type: 'signin', checked: 'live', blurb: 'Your Prisma Postgres databases', run: remote('https://mcp.prisma.io/mcp') },
  { id: 'posthog', name: 'PostHog', icon: 'PH', category: 'Data', type: 'signin', checked: 'live', blurb: 'Product analytics, feature flags and errors in PostHog', run: remote('https://mcp.posthog.com/mcp') },
  { id: 'mapbox', name: 'Mapbox', icon: 'MAP', category: 'Data', type: 'signin', checked: 'live', blurb: 'Places, directions and maps through Mapbox', run: remote('https://mcp.mapbox.com/mcp') },
  { id: 'charts', name: 'Charts', icon: 'CH', category: 'Data', type: 'local', checked: 'starts', blurb: 'Turn data into charts: bar, line, pie and more', run: ['npx', '-y', '@antv/mcp-server-chart'] },

  // --------------------------------------------------------- Design & sites
  { id: 'figma', name: 'Figma', icon: 'FIG', category: 'Design & sites', type: 'signin', checked: 'live', blurb: 'Read designs from your Figma files', run: remote('https://mcp.figma.com/mcp') },
  { id: 'canva', name: 'Canva', icon: 'CV', category: 'Design & sites', type: 'signin', checked: 'live', blurb: 'Your Canva designs', run: remote('https://mcp.canva.com/mcp') },
  { id: 'webflow', name: 'Webflow', icon: 'WF', category: 'Design & sites', type: 'signin', checked: 'live', blurb: 'Your Webflow sites and content', run: remote('https://mcp.webflow.com/sse') },
  { id: 'wix', name: 'Wix', icon: 'WIX', category: 'Design & sites', type: 'signin', checked: 'live', blurb: 'Your Wix sites', run: remote('https://mcp.wix.com/sse') },

  // --------------------------------------------------------------- Business
  { id: 'stripe', name: 'Stripe', icon: 'STR', category: 'Business', type: 'signin', checked: 'live', blurb: 'Customers, payments and products in Stripe', run: remote('https://mcp.stripe.com') },
  { id: 'paypal', name: 'PayPal', icon: 'PP', category: 'Business', type: 'signin', checked: 'live', blurb: 'Invoices and transactions in PayPal', run: remote('https://mcp.paypal.com/sse') },
  { id: 'square', name: 'Square', icon: 'SQ', category: 'Business', type: 'signin', checked: 'live', blurb: 'Payments, catalog and orders in Square', run: remote('https://mcp.squareup.com/sse') },
  { id: 'close', name: 'Close CRM', icon: 'CL', category: 'Business', type: 'signin', checked: 'live', blurb: 'Leads, contacts and deals in Close', run: remote('https://mcp.close.com/mcp') },
  { id: 'hubspot', name: 'HubSpot', icon: 'HS', category: 'Business', type: 'signin', checked: 'live', blurb: 'Contacts, companies and deals in HubSpot', run: remote('https://mcp.hubspot.com/anthropic') },

  // ---------------------------------------------------------- This computer
  {
    id: 'filesystem',
    name: 'Another folder',
    icon: 'DIR',
    category: 'This computer',
    type: 'local',
    checked: 'used',
    blurb: 'Let the crew read and write files in a folder outside the workspace',
    run: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '{path}'],
    fields: [{ id: 'path', label: 'Folder', placeholder: 'C:/path/to/folder' }],
  },
  { id: 'memory', name: 'Memory', icon: 'MEM', category: 'This computer', type: 'local', checked: 'used', blurb: 'A notebook the crew can save facts to and look them up in later', run: ['npx', '-y', '@modelcontextprotocol/server-memory'] },
  { id: 'thinking', name: 'Step-by-step thinking', icon: 'THK', category: 'This computer', type: 'local', checked: 'used', blurb: 'A scratchpad for working through a hard problem in steps', run: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'] },
];

const SIGN_IN_TIMEOUT_MS = 5 * 60000; // the user has to get through a sign-in page first

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** The catalog as the dashboard sees it: no commands, just what to show and what to ask for. */
export function publicCatalog() {
  return {
    categories: CATEGORIES,
    entries: CATALOG.map(({ run, fields = [], ...entry }) => ({
      ...entry,
      fields: fields.map(({ id, label, placeholder = '', secret = false, help = '' }) => ({ id, label, placeholder, secret, help })),
    })),
  };
}

/** Turn a catalog entry plus what the user typed into something McpHub can start. */
/**
 * For an entry that names a credential type in `verify`, ask the service whether the values work
 * before anything is started. Throws a plain message the dashboard can show.
 */
export async function checkFields(id, values = {}, fetchImpl = fetch) {
  const entry = CATALOG.find((e) => e.id === id);
  const type = entry?.verify && CREDENTIAL_TYPES[entry.verify];
  if (!type) return;
  try {
    await type.verify(Object.fromEntries((entry.fields ?? []).map((f) => [f.id, String(values[f.id] ?? '').trim()])), fetchImpl);
  } catch (err) {
    throw fail(`${entry.name} did not accept that, so it was not started: ${err.message}`, 400);
  }
}

export function specFor(id, values = {}) {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) throw fail('That connector is not in the catalog', 404);
  if (!entry.run) throw fail(`${entry.name} is set up in its own panel`);

  const filled = {};
  for (const field of entry.fields ?? []) {
    const value = String(values[field.id] ?? '').trim();
    if (!value) throw fail(`${field.label} is needed to connect ${entry.name}`);
    if (/["\r\n]/.test(value)) throw fail(`${field.label} cannot contain quotes or line breaks`);
    filled[field.id] = value;
  }
  const env = Object.fromEntries((entry.fields ?? []).filter((f) => f.env).map((f) => [f.env, `${f.prefix ?? ''}${filled[f.id]}`]));
  return {
    name: entry.id,
    // "{path}"-style placeholders are filled in; "${VAR}" ones are left for the helper to read from env.
    command: entry.run.map((part) => part.replace(/^\{(\w+)\}$/, (_, key) => filled[key] ?? '')),
    env,
    startupTimeoutMs: entry.type === 'signin' ? SIGN_IN_TIMEOUT_MS : undefined,
  };
}

/** One line per connection for the Chef, so it can decide which a sub-task needs. */
export function describeConnection(id) {
  if (id === 'google') return "the user's Google Drive, Docs, Sheets, Gmail and Calendar (read-only)";
  return CATALOG.find((e) => e.id === id)?.blurb ?? null;
}
