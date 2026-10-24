import crypto from 'node:crypto';
import { clip } from './util.js';
import { toText } from './flowData.js';

/**
 * Built-in services for flows: small, direct calls to well-known APIs, one
 * node per app. No MCP server is involved and no model: a
 * service node sends one request (or two) and hands on what came back.
 *
 * Every endpoint here was probed in October 2026: with a wrong key it answers
 * 401 (Telegram, Resend, GitHub, Notion, Todoist, Trello) or 404 (Discord,
 * Slack webhooks), and the keyless ones (ntfy, RSS, Hacker News, Wikipedia,
 * Open-Meteo, Frankfurter) answered a real request. Todoist's old REST v2
 * answers 410 now, so its v1 API is used; Reddit's JSON API refuses plain
 * requests (403), so Reddit is read through its RSS feed.
 *
 *   checked  'used'  a real request from this code answered as expected
 *            'live'  the endpoint exists and rejects a wrong key; a full
 *                    round with a real account has not been tried
 *
 * A field marked `fixed` takes no {{ expressions }}: it is an address, a
 * recipient or a repository, and text that arrived from outside must not be
 * able to choose those. Everything else may quote the flow's data.
 */

const TIMEOUT_MS = 20000;
const MAX_BYTES = 2_000_000;
const fail = (message) => new Error(message);

/** A request with a time limit, read as JSON when it is JSON. Error messages never carry the address (it may hold a token). */
export async function request(fetch, url, { method = 'GET', headers = {}, body, signal, name = new URL(url).host } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw fail('stopped');
    throw fail(`could not reach ${name} (${err.cause?.code ?? (err.name === 'TimeoutError' ? 'no answer in 20 s' : err.message)})`);
  }
  const text = await res.text().catch(() => '');
  if (text.length > MAX_BYTES) throw fail(`${name} sent more than 2 MB`);
  let data = text;
  if (/json/i.test(res.headers.get('content-type') ?? '') || /^\s*[[{]/.test(text)) {
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  if (!res.ok) {
    const why = typeof data === 'object' && data ? (data.message ?? data.description ?? data.error?.message ?? data.error ?? data.errors?.[0]?.message ?? '') : clip(String(data), 160);
    if (res.status === 401 || res.status === 403) throw fail(`${name} refused the credential (${res.status})${why ? `: ${clip(toText(why), 160)}` : ''}`);
    throw fail(`${name} answered ${res.status}${why ? `: ${clip(toText(why), 200)}` : ''}`);
  }
  return data;
}

// ------------------------------------------------------------------ RSS / Atom

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? whole)));
const strip = (html) => decode(html).replace(/<[^>]*>/g, ' ').replace(/&(#x?[0-9a-f]+|\w+);/gi, (w) => decode(w)).replace(/\s+/g, ' ').trim();
const tag = (block, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : '';
};

/** The items of an RSS or Atom feed, newest first as the feed lists them. No XML library: feeds are regular enough. */
export function parseFeed(xml) {
  const blocks = [...String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  return blocks.map((b) => {
    const link = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? decode(tag(b, 'link')).trim();
    return {
      title: strip(tag(b, 'title')),
      link: decode(link),
      id: decode(tag(b, 'guid') || tag(b, 'id')).trim() || link,
      published: strip(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
      author: strip(tag(b, 'author') || tag(b, 'dc:creator')).slice(0, 100),
      summary: clip(strip(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || tag(b, 'content:encoded')), 800),
    };
  });
}

const readFeed = async (fetch, url, limit, signal) => {
  const xml = await request(fetch, url, { headers: { 'user-agent': 'kadhai/1.0 (feed reader)', accept: 'application/rss+xml, application/atom+xml, text/xml, */*' }, signal });
  const items = parseFeed(typeof xml === 'string' ? xml : '');
  if (!items.length) throw fail('that address did not answer with an RSS or Atom feed');
  return items.slice(0, limit);
};

// ---------------------------------------------------------------- helpers

const int = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};
const REPO = /^[\w.-]+\/[\w.-]+$/;
const repoOf = (v) => {
  const repo = String(v ?? '').trim();
  if (!REPO.test(repo)) throw fail('Give the repository as owner/name');
  return repo;
};
const github = (cred) => ({ accept: 'application/vnd.github+json', 'user-agent': 'kadhai', 'x-github-api-version': '2022-11-28', ...(cred?.token ? { authorization: `Bearer ${cred.token}` } : {}) });
const compactIssue = (i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, author: i.user?.login, labels: (i.labels ?? []).map((l) => l.name), created: i.created_at, body: clip(i.body ?? '', 600) });
const notion = (cred) => ({ authorization: `Bearer ${cred.token}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' });
const paragraphs = (text) =>
  String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((p) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 2000) } }] } }));
const notionTitle = (page) => {
  const props = Object.values(page.properties ?? {});
  const title = props.find((p) => p.type === 'title')?.title ?? page.title ?? [];
  return title.map((t) => t.plain_text).join('');
};
const todoist = (cred) => ({ authorization: `Bearer ${cred.token}`, 'content-type': 'application/json' });
const trelloAuth = (cred) => `key=${encodeURIComponent(cred.key)}&token=${encodeURIComponent(cred.token)}`;
const hnItem = (h) => ({ title: h.title ?? h.story_title, url: h.url ?? h.story_url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points, comments: h.num_comments, author: h.author, hn: `https://news.ycombinator.com/item?id=${h.objectID}`, created: h.created_at, id: h.objectID });
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail' };
const currencyCode = (v, what) => {
  const code = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw fail(`${what} must be a three-letter currency code, e.g. USD`);
  return code;
};
const lang = (v) => (/^[a-z]{2,3}$/.test(String(v ?? '')) ? v : 'en');
const httpsOrLocal = (v, what = 'The address') => {
  let url;
  try {
    url = new URL(String(v ?? '').trim());
  } catch {
    throw fail(`${what} must be a full address, e.g. https://example.com/feed.xml`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw fail(`${what} must start with https://`);
  return url.href;
};

// ------------------------------------------------------------- credentials

/**
 * The kinds of credential a flow can keep. `secret` fields are stored
 * encrypted and never sent back to the browser; the others are shown.
 * `verify` makes one cheap request that only succeeds with a good credential.
 */
export const CREDENTIAL_TYPES = {
  telegram: {
    label: 'Telegram bot',
    help: 'https://core.telegram.org/bots/features#botfather',
    fields: [{ id: 'token', label: 'Bot token (from @BotFather)', secret: true, pattern: '^\\d+:[\\w-]{20,}$' }],
    verify: async (c, fetch) => `@${(await request(fetch, `https://api.telegram.org/bot${c.token}/getMe`, { name: 'Telegram' })).result?.username}`,
  },
  discord: {
    label: 'Discord webhook',
    help: 'https://support.discord.com/hc/en-us/articles/228383668',
    fields: [{ id: 'url', label: 'Webhook address (channel settings, Integrations)', secret: true, pattern: '^https://(?:\\w+\\.)?discord(?:app)?\\.com/api/webhooks/\\d+/[\\w-]+$' }],
    verify: async (c, fetch) => `#${(await request(fetch, c.url, { name: 'Discord' })).name ?? 'webhook'}`,
  },
  slack: {
    label: 'Slack incoming webhook',
    help: 'https://api.slack.com/messaging/webhooks',
    fields: [{ id: 'url', label: 'Webhook address', secret: true, pattern: '^https://hooks\\.slack\\.com/services/[\\w/]+$' }],
  },
  ntfy: {
    label: 'ntfy server',
    help: 'https://docs.ntfy.sh/publish/',
    fields: [
      { id: 'server', label: 'Server (empty = ntfy.sh)', placeholder: 'https://ntfy.sh', optional: true },
      { id: 'token', label: 'Access token (only for a protected topic)', secret: true, optional: true },
    ],
  },
  resend: {
    label: 'Resend (email)',
    help: 'https://resend.com/api-keys',
    fields: [{ id: 'key', label: 'API key', secret: true, pattern: '^re_\\w+$' }],
  },
  github: {
    label: 'GitHub token',
    help: 'https://github.com/settings/personal-access-tokens',
    fields: [{ id: 'token', label: 'Personal access token', secret: true }],
    verify: async (c, fetch) => `@${(await request(fetch, 'https://api.github.com/user', { headers: github(c), name: 'GitHub' })).login}`,
  },
  notion: {
    label: 'Notion integration',
    help: 'https://www.notion.so/profile/integrations',
    fields: [{ id: 'token', label: 'Internal integration secret', secret: true }],
    verify: async (c, fetch) => (await request(fetch, 'https://api.notion.com/v1/users/me', { headers: notion(c), name: 'Notion' })).name ?? 'connected',
  },
  todoist: {
    label: 'Todoist',
    help: 'https://app.todoist.com/app/settings/integrations/developer',
    fields: [{ id: 'token', label: 'API token', secret: true }],
    verify: async (c, fetch) => {
      await request(fetch, 'https://api.todoist.com/api/v1/projects?limit=1', { headers: todoist(c), name: 'Todoist' });
      return 'connected';
    },
  },
  trello: {
    label: 'Trello',
    help: 'https://trello.com/power-ups/admin',
    fields: [
      { id: 'key', label: 'API key', secret: true },
      { id: 'token', label: 'Token', secret: true },
    ],
    verify: async (c, fetch) => `@${(await request(fetch, `https://api.trello.com/1/members/me?${trelloAuth(c)}`, { name: 'Trello' })).username}`,
  },
  bearer: {
    label: 'Bearer token (any API)',
    fields: [{ id: 'token', label: 'Token', secret: true }],
  },
  header: {
    label: 'API key in a header (any API)',
    fields: [
      { id: 'name', label: 'Header name', placeholder: 'X-API-Key', pattern: '^[A-Za-z0-9-]{1,60}$' },
      { id: 'value', label: 'Value', secret: true },
    ],
  },
  query: {
    label: 'API key in the address (any API)',
    fields: [
      { id: 'name', label: 'Parameter name', placeholder: 'api_key', pattern: '^[\\w.-]{1,60}$' },
      { id: 'value', label: 'Value', secret: true },
    ],
  },
  basic: {
    label: 'User name and password (any API)',
    fields: [
      { id: 'user', label: 'User name' },
      { id: 'password', label: 'Password', secret: true },
    ],
  },
};

/** Put a generic credential onto a request: a header, or a parameter in the address. */
export function applyCredential(cred, url, headers) {
  if (!cred) return url;
  if (cred.type === 'bearer') headers.authorization = `Bearer ${cred.token}`;
  else if (cred.type === 'header') headers[cred.name.toLowerCase()] = cred.value;
  else if (cred.type === 'basic') headers.authorization = `Basic ${Buffer.from(`${cred.user}:${cred.password}`).toString('base64')}`;
  else if (cred.type === 'query') {
    const u = new URL(url);
    u.searchParams.set(cred.name, cred.value);
    return u.href;
  } else if (cred.token) headers.authorization = `Bearer ${cred.token}`;
  return url;
}

// --------------------------------------------------------------- services

const f = (id, label, more = {}) => ({ id, label, ...more });

/**
 * Each service: a label, the credential type it needs (`auth`, or none; `authOptional` when it
 * works without one), and actions. An action lists its fields and has run({ p, cred, fetch, signal }).
 */
export const SERVICES = {
  telegram: {
    label: 'Telegram',
    auth: 'telegram',
    checked: 'live',
    actions: {
      send: {
        label: 'Send a message',
        fields: [f('chat', 'Chat id', { placeholder: '123456789, or {{ trigger.chat }} to answer the chat that wrote' }), f('text', 'Message', { long: true, placeholder: '{{ input }}' })],
        run: async ({ p, cred, fetch, signal }) => {
          if (!/^-?\d{1,20}$|^@\w{4,}$/.test(String(p.chat).trim())) throw fail('The chat id is a number (or @channelname)');
          const out = await request(fetch, `https://api.telegram.org/bot${cred.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: String(p.chat).trim(), text: clip(toText(p.text), 4000) || '(empty)' }), signal, name: 'Telegram' });
          return { sent: true, message_id: out.result?.message_id, chat: out.result?.chat?.id };
        },
      },
    },
  },
  discord: {
    label: 'Discord',
    auth: 'discord',
    checked: 'live',
    actions: {
      send: {
        label: 'Post to a channel',
        fields: [f('text', 'Message', { long: true, placeholder: '{{ input }}' }), f('username', 'Post as (optional)', { optional: true, placeholder: 'Kadhai' })],
        run: async ({ p, cred, fetch, signal }) => {
          const out = await request(fetch, `${cred.url}?wait=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: clip(toText(p.text), 2000) || '(empty)', ...(p.username ? { username: clip(toText(p.username), 80) } : {}), allowed_mentions: { parse: [] } }), signal, name: 'Discord' });
          return { sent: true, id: out?.id, channel: out?.channel_id };
        },
      },
    },
  },
  slack: {
    label: 'Slack',
    auth: 'slack',
    checked: 'live',
    actions: {
      send: {
        label: 'Post to a channel',
        fields: [f('text', 'Message', { long: true, placeholder: '{{ input }}' })],
        run: async ({ p, cred, fetch, signal }) => {
          await request(fetch, cred.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: clip(toText(p.text), 3500) || '(empty)' }), signal, name: 'Slack' });
          return { sent: true };
        },
      },
    },
  },
  ntfy: {
    label: 'ntfy (phone push)',
    auth: 'ntfy',
    authOptional: true,
    checked: 'used',
    about: 'Free push notifications to the ntfy app on your phone. No account: pick a hard-to-guess topic and subscribe to it in the app.',
    actions: {
      send: {
        label: 'Send a notification',
        fields: [
          f('topic', 'Topic', { fixed: true, placeholder: 'my-kadhai-7f3a' }),
          f('title', 'Title (optional)', { optional: true }),
          f('message', 'Message', { long: true, placeholder: '{{ input }}' }),
          f('priority', 'Priority 1-5 (optional)', { optional: true, fixed: true, placeholder: '3' }),
          f('click', 'Open this address when tapped (optional)', { optional: true }),
        ],
        run: async ({ p, cred, fetch, signal }) => {
          const topic = String(p.topic ?? '').trim();
          if (!/^[\w-]{1,64}$/.test(topic)) throw fail('A topic is letters, digits, - and _ (up to 64)');
          const server = httpsOrLocal(cred?.server || 'https://ntfy.sh', 'The ntfy server').replace(/\/+$/, '');
          const body = { topic, message: clip(toText(p.message), 4000) || '(empty)', ...(p.title ? { title: clip(toText(p.title), 200) } : {}), ...(p.priority ? { priority: int(p.priority, 1, 5, 3) } : {}) };
          if (p.click && /^https?:\/\//.test(toText(p.click))) body.click = clip(toText(p.click), 500);
          const out = await request(fetch, server, { method: 'POST', headers: { 'content-type': 'application/json', ...(cred?.token ? { authorization: `Bearer ${cred.token}` } : {}) }, body: JSON.stringify(body), signal, name: 'ntfy' });
          return { sent: true, id: out?.id, topic };
        },
      },
    },
  },
  email: {
    label: 'Email (Resend)',
    auth: 'resend',
    checked: 'live',
    about: 'Send email through Resend (free tier: 3,000 a month). The sender must be an address on a domain you verified there, or onboarding@resend.dev for tests to yourself.',
    actions: {
      send: {
        label: 'Send an email',
        fields: [
          f('from', 'From', { fixed: true, placeholder: 'Kadhai <bot@yourdomain.com>' }),
          f('to', 'To (up to 5, comma separated)', { fixed: true, placeholder: 'you@example.com' }),
          f('subject', 'Subject'),
          f('text', 'Text', { long: true, placeholder: '{{ input }}' }),
        ],
        run: async ({ p, cred, fetch, signal }) => {
          const to = String(p.to ?? '').split(/[,;\s]+/).filter(Boolean);
          if (!to.length || to.length > 5 || to.some((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))) throw fail('Give one to five email addresses');
          const out = await request(fetch, 'https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${cred.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: String(p.from).trim(), to, subject: clip(toText(p.subject), 200) || '(no subject)', text: clip(toText(p.text), 50000) || ' ' }), signal, name: 'Resend' });
          return { sent: true, id: out?.id };
        },
      },
    },
  },
  github: {
    label: 'GitHub',
    auth: 'github',
    authOptional: true,
    checked: 'used',
    about: 'Reading a public repository needs no token; writing (issues, comments) does.',
    actions: {
      create_issue: {
        label: 'Create an issue',
        needsAuth: true,
        fields: [f('repo', 'Repository', { fixed: true, placeholder: 'owner/name' }), f('title', 'Title'), f('body', 'Text', { long: true, optional: true }), f('labels', 'Labels (comma separated, optional)', { fixed: true, optional: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const labels = String(p.labels ?? '').split(',').map((l) => l.trim()).filter(Boolean).slice(0, 10);
          const out = await request(fetch, `https://api.github.com/repos/${repoOf(p.repo)}/issues`, { method: 'POST', headers: { ...github(cred), 'content-type': 'application/json' }, body: JSON.stringify({ title: clip(toText(p.title), 250) || 'Untitled', body: clip(toText(p.body), 60000), ...(labels.length ? { labels } : {}) }), signal, name: 'GitHub' });
          return compactIssue(out);
        },
      },
      comment: {
        label: 'Comment on an issue or PR',
        needsAuth: true,
        fields: [f('repo', 'Repository', { fixed: true, placeholder: 'owner/name' }), f('number', 'Issue or PR number', { placeholder: '{{ input.number }}' }), f('body', 'Comment', { long: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const n = String(p.number ?? '').trim();
          if (!/^\d{1,9}$/.test(n)) throw fail('The issue number is a whole number');
          const out = await request(fetch, `https://api.github.com/repos/${repoOf(p.repo)}/issues/${n}/comments`, { method: 'POST', headers: { ...github(cred), 'content-type': 'application/json' }, body: JSON.stringify({ body: clip(toText(p.body), 60000) || '(empty)' }), signal, name: 'GitHub' });
          return { id: out.id, url: out.html_url };
        },
      },
      list_issues: {
        label: 'List issues',
        fields: [f('repo', 'Repository', { fixed: true, placeholder: 'owner/name' }), f('state', 'State: open, closed or all', { fixed: true, optional: true, placeholder: 'open' }), f('labels', 'Only with these labels (optional)', { fixed: true, optional: true }), f('limit', 'How many (up to 50)', { fixed: true, optional: true, placeholder: '20' })],
        run: async ({ p, cred, fetch, signal }) => {
          const limit = int(p.limit, 1, 50, 20);
          // GitHub's issue list includes pull requests: ask for more, then keep only the issues.
          const q = new URLSearchParams({ state: ['open', 'closed', 'all'].includes(p.state) ? p.state : 'open', per_page: '100', ...(p.labels ? { labels: String(p.labels) } : {}) });
          const out = await request(fetch, `https://api.github.com/repos/${repoOf(p.repo)}/issues?${q}`, { headers: github(cred), signal, name: 'GitHub' });
          return out.filter((i) => !i.pull_request).slice(0, limit).map(compactIssue);
        },
      },
      list_pulls: {
        label: 'List pull requests',
        fields: [f('repo', 'Repository', { fixed: true, placeholder: 'owner/name' }), f('state', 'State: open, closed or all', { fixed: true, optional: true, placeholder: 'open' }), f('limit', 'How many (up to 50)', { fixed: true, optional: true, placeholder: '20' })],
        run: async ({ p, cred, fetch, signal }) => {
          const q = new URLSearchParams({ state: ['open', 'closed', 'all'].includes(p.state) ? p.state : 'open', per_page: String(int(p.limit, 1, 50, 20)) });
          const out = await request(fetch, `https://api.github.com/repos/${repoOf(p.repo)}/pulls?${q}`, { headers: github(cred), signal, name: 'GitHub' });
          return out.map((pr) => ({ ...compactIssue(pr), branch: pr.head?.ref, draft: pr.draft }));
        },
      },
      latest_release: {
        label: 'Latest release',
        fields: [f('repo', 'Repository', { fixed: true, placeholder: 'owner/name' })],
        run: async ({ p, cred, fetch, signal }) => {
          const r = await request(fetch, `https://api.github.com/repos/${repoOf(p.repo)}/releases/latest`, { headers: github(cred), signal, name: 'GitHub' });
          return { tag: r.tag_name, name: r.name, url: r.html_url, published: r.published_at, notes: clip(r.body ?? '', 3000) };
        },
      },
      get_file: {
        label: 'Read a file',
        fields: [f('repo', 'Repository', { fixed: true, placeholder: 'owner/name' }), f('path', 'Path in the repository', { fixed: true, placeholder: 'README.md' }), f('ref', 'Branch or tag (optional)', { fixed: true, optional: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const file = String(p.path ?? '').trim().replace(/^\/+/, '');
          if (!file || file.includes('..')) throw fail('Give a path inside the repository');
          const q = p.ref ? `?ref=${encodeURIComponent(p.ref)}` : '';
          const out = await request(fetch, `https://api.github.com/repos/${repoOf(p.repo)}/contents/${file.split('/').map(encodeURIComponent).join('/')}${q}`, { headers: github(cred), signal, name: 'GitHub' });
          if (Array.isArray(out) || out.type !== 'file') throw fail('That path is a folder, not a file');
          return { path: out.path, size: out.size, url: out.html_url, content: clip(Buffer.from(out.content ?? '', 'base64').toString('utf8'), 100000) };
        },
      },
    },
  },
  notion: {
    label: 'Notion',
    auth: 'notion',
    checked: 'live',
    about: 'Share the page or database with your integration in Notion first (... menu, Connections).',
    actions: {
      create_page: {
        label: 'Add a page to a database',
        fields: [f('database', 'Database id', { fixed: true, placeholder: 'from the database address: notion.so/…/<id>?v=…' }), f('title', 'Title'), f('text', 'Text (optional)', { long: true, optional: true }), f('titleProp', 'Name of the title column', { fixed: true, optional: true, placeholder: 'Name' })],
        run: async ({ p, cred, fetch, signal }) => {
          const db = String(p.database ?? '').replace(/-/g, '').trim();
          if (!/^[0-9a-f]{32}$/i.test(db)) throw fail('A database id is 32 letters and digits');
          const out = await request(fetch, 'https://api.notion.com/v1/pages', { method: 'POST', headers: notion(cred), body: JSON.stringify({ parent: { database_id: db }, properties: { [String(p.titleProp || 'Name')]: { title: [{ text: { content: clip(toText(p.title), 2000) || 'Untitled' } }] } }, children: paragraphs(toText(p.text)) }), signal, name: 'Notion' });
          return { id: out.id, url: out.url };
        },
      },
      append: {
        label: 'Add text to a page',
        fields: [f('page', 'Page id', { fixed: true }), f('text', 'Text', { long: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const page = String(p.page ?? '').replace(/-/g, '').trim();
          if (!/^[0-9a-f]{32}$/i.test(page)) throw fail('A page id is 32 letters and digits');
          await request(fetch, `https://api.notion.com/v1/blocks/${page}/children`, { method: 'PATCH', headers: notion(cred), body: JSON.stringify({ children: paragraphs(toText(p.text)) }), signal, name: 'Notion' });
          return { added: true, page };
        },
      },
      search: {
        label: 'Search',
        fields: [f('query', 'Search for', { placeholder: '{{ input }}' })],
        run: async ({ p, cred, fetch, signal }) => {
          const out = await request(fetch, 'https://api.notion.com/v1/search', { method: 'POST', headers: notion(cred), body: JSON.stringify({ query: clip(toText(p.query), 200), page_size: 10 }), signal, name: 'Notion' });
          return (out.results ?? []).map((r) => ({ id: r.id, kind: r.object, title: notionTitle(r), url: r.url }));
        },
      },
    },
  },
  todoist: {
    label: 'Todoist',
    auth: 'todoist',
    checked: 'live',
    actions: {
      create_task: {
        label: 'Add a task',
        fields: [f('content', 'Task'), f('description', 'Details (optional)', { long: true, optional: true }), f('due', 'Due, in words (optional)', { optional: true, placeholder: 'tomorrow 9am' }), f('priority', 'Priority 1-4 (optional)', { fixed: true, optional: true }), f('project', 'Project id (optional)', { fixed: true, optional: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const body = { content: clip(toText(p.content), 500) || 'Untitled', ...(p.description ? { description: clip(toText(p.description), 16000) } : {}), ...(p.due ? { due_string: clip(toText(p.due), 100) } : {}), ...(p.priority ? { priority: int(p.priority, 1, 4, 1) } : {}), ...(p.project ? { project_id: String(p.project).trim() } : {}) };
          const t = await request(fetch, 'https://api.todoist.com/api/v1/tasks', { method: 'POST', headers: todoist(cred), body: JSON.stringify(body), signal, name: 'Todoist' });
          return { id: t.id, content: t.content, due: t.due?.string ?? null };
        },
      },
      list_tasks: {
        label: 'List open tasks',
        fields: [f('project', 'Project id (optional)', { fixed: true, optional: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const q = new URLSearchParams({ limit: '50', ...(p.project ? { project_id: String(p.project).trim() } : {}) });
          const out = await request(fetch, `https://api.todoist.com/api/v1/tasks?${q}`, { headers: todoist(cred), signal, name: 'Todoist' });
          return (out.results ?? out ?? []).map((t) => ({ id: t.id, content: t.content, due: t.due?.string ?? null, priority: t.priority }));
        },
      },
      close_task: {
        label: 'Complete a task',
        fields: [f('id', 'Task id', { placeholder: '{{ input.id }}' })],
        run: async ({ p, cred, fetch, signal }) => {
          const id = String(p.id ?? '').trim();
          if (!/^[\w-]{1,40}$/.test(id)) throw fail('That is not a task id');
          await request(fetch, `https://api.todoist.com/api/v1/tasks/${id}/close`, { method: 'POST', headers: todoist(cred), signal, name: 'Todoist' });
          return { closed: id };
        },
      },
    },
  },
  trello: {
    label: 'Trello',
    auth: 'trello',
    checked: 'live',
    actions: {
      create_card: {
        label: 'Add a card',
        fields: [f('list', 'List id', { fixed: true }), f('name', 'Card title'), f('desc', 'Description (optional)', { long: true, optional: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const list = String(p.list ?? '').trim();
          if (!/^[0-9a-f]{24}$/i.test(list)) throw fail('A Trello list id is 24 letters and digits');
          const c = await request(fetch, `https://api.trello.com/1/cards?idList=${list}&${trelloAuth(cred)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: clip(toText(p.name), 500) || 'Untitled', desc: clip(toText(p.desc), 16000) }), signal, name: 'Trello' });
          return { id: c.id, url: c.shortUrl ?? c.url };
        },
      },
      list_cards: {
        label: 'List the cards of a list',
        fields: [f('list', 'List id', { fixed: true })],
        run: async ({ p, cred, fetch, signal }) => {
          const list = String(p.list ?? '').trim();
          if (!/^[0-9a-f]{24}$/i.test(list)) throw fail('A Trello list id is 24 letters and digits');
          const cards = await request(fetch, `https://api.trello.com/1/lists/${list}/cards?${trelloAuth(cred)}`, { signal, name: 'Trello' });
          return cards.map((c) => ({ id: c.id, name: c.name, url: c.shortUrl, due: c.due, desc: clip(c.desc ?? '', 400) }));
        },
      },
    },
  },
  rss: {
    label: 'RSS feed',
    checked: 'used',
    actions: {
      read: {
        label: 'Read the latest items',
        fields: [f('url', 'Feed address', { fixed: true, placeholder: 'https://github.com/nodejs/node/releases.atom' }), f('limit', 'How many (up to 30)', { fixed: true, optional: true, placeholder: '10' })],
        run: ({ p, fetch, signal }) => readFeed(fetch, httpsOrLocal(p.url, 'The feed address'), int(p.limit, 1, 30, 10), signal),
      },
    },
  },
  reddit: {
    label: 'Reddit',
    checked: 'used',
    about: 'Read through the public RSS feeds of Reddit, which limits how often they may be read: a few times an hour is fine.',
    actions: {
      read: {
        label: 'Read a subreddit',
        fields: [f('subreddit', 'Subreddit', { fixed: true, placeholder: 'programming' }), f('sort', 'hot, new or top', { fixed: true, optional: true, placeholder: 'hot' }), f('limit', 'How many (up to 25)', { fixed: true, optional: true, placeholder: '10' })],
        run: ({ p, fetch, signal }) => {
          const sub = String(p.subreddit ?? '').replace(/^\/?r\//, '').trim();
          if (!/^\w{2,21}$/.test(sub)) throw fail('Give the subreddit name, e.g. programming');
          const sort = ['hot', 'new', 'top'].includes(p.sort) ? p.sort : 'hot';
          return readFeed(fetch, `https://www.reddit.com/r/${sub}/${sort}/.rss`, int(p.limit, 1, 25, 10), signal);
        },
      },
    },
  },
  hackernews: {
    label: 'Hacker News',
    checked: 'used',
    actions: {
      front_page: {
        label: 'Front page',
        fields: [f('limit', 'How many (up to 30)', { fixed: true, optional: true, placeholder: '10' })],
        run: async ({ p, fetch, signal }) => (await request(fetch, `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${int(p.limit, 1, 30, 10)}`, { signal, name: 'Hacker News' })).hits.map(hnItem),
      },
      search: {
        label: 'Search stories',
        fields: [f('query', 'Search for'), f('limit', 'How many (up to 30)', { fixed: true, optional: true, placeholder: '10' })],
        run: async ({ p, fetch, signal }) => (await request(fetch, `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(clip(toText(p.query), 200))}&hitsPerPage=${int(p.limit, 1, 30, 10)}`, { signal, name: 'Hacker News' })).hits.map(hnItem),
      },
    },
  },
  wikipedia: {
    label: 'Wikipedia',
    checked: 'used',
    actions: {
      summary: {
        label: 'Summary of an article',
        fields: [f('title', 'Article', { placeholder: 'Node.js' }), f('lang', 'Language code (optional)', { fixed: true, optional: true, placeholder: 'en' })],
        run: async ({ p, fetch, signal }) => {
          const title = clip(toText(p.title), 200).trim().replace(/ /g, '_');
          if (!title) throw fail('Name an article');
          const out = await request(fetch, `https://${lang(p.lang)}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: { 'user-agent': 'kadhai/1.0' }, signal, name: 'Wikipedia' });
          return { title: out.title, description: out.description ?? '', extract: out.extract ?? '', url: out.content_urls?.desktop?.page };
        },
      },
      search: {
        label: 'Search articles',
        fields: [f('query', 'Search for'), f('lang', 'Language code (optional)', { fixed: true, optional: true, placeholder: 'en' })],
        run: async ({ p, fetch, signal }) => {
          const l = lang(p.lang);
          const out = await request(fetch, `https://${l}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=${encodeURIComponent(clip(toText(p.query), 200))}`, { headers: { 'user-agent': 'kadhai/1.0' }, signal, name: 'Wikipedia' });
          return (out.query?.search ?? []).map((r) => ({ title: r.title, snippet: strip(r.snippet), url: `https://${l}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}` }));
        },
      },
    },
  },
  weather: {
    label: 'Weather',
    checked: 'used',
    about: 'From Open-Meteo: free, no key.',
    actions: {
      forecast: {
        label: 'Now and the next 3 days',
        fields: [f('place', 'Place', { placeholder: 'Chennai' })],
        run: async ({ p, fetch, signal }) => {
          const name = clip(toText(p.place), 100).trim();
          if (!name) throw fail('Name a place');
          const geo = await request(fetch, `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name)}`, { signal, name: 'Open-Meteo' });
          const at = geo.results?.[0];
          if (!at) throw fail(`No place called "${name}" was found`);
          const q = new URLSearchParams({ latitude: at.latitude, longitude: at.longitude, timezone: 'auto', forecast_days: '3', current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' });
          const w = await request(fetch, `https://api.open-meteo.com/v1/forecast?${q}`, { signal, name: 'Open-Meteo' });
          const c = w.current ?? {};
          return {
            place: [at.name, at.admin1, at.country].filter(Boolean).join(', '),
            now: { temperature: c.temperature_2m, feels_like: c.apparent_temperature, humidity: c.relative_humidity_2m, wind_kmh: c.wind_speed_10m, rain_mm: c.precipitation, sky: WMO[c.weather_code] ?? '', time: c.time },
            days: (w.daily?.time ?? []).map((day, i) => ({ day, sky: WMO[w.daily.weather_code[i]] ?? '', max: w.daily.temperature_2m_max[i], min: w.daily.temperature_2m_min[i], rain_chance: w.daily.precipitation_probability_max?.[i] })),
          };
        },
      },
    },
  },
  currency: {
    label: 'Currency',
    checked: 'used',
    about: 'Reference rates from the European Central Bank, through Frankfurter: free, no key, updated once a working day.',
    actions: {
      convert: {
        label: 'Convert an amount',
        fields: [f('amount', 'Amount', { placeholder: '100' }), f('from', 'From', { placeholder: 'USD' }), f('to', 'To', { placeholder: 'INR' })],
        run: async ({ p, fetch, signal }) => {
          const amount = Number(toText(p.amount).replace(/,/g, ''));
          if (!Number.isFinite(amount)) throw fail('The amount must be a number');
          const from = currencyCode(p.from, 'From');
          const to = currencyCode(p.to, 'To');
          if (from === to) return { amount, from, to, rate: 1, result: amount };
          const out = await request(fetch, `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, { signal, name: 'Frankfurter' });
          const rate = out.rates?.[to];
          if (rate == null) throw fail(`No rate for ${from} to ${to}`);
          return { amount, from, to, rate, result: Math.round(amount * rate * 100) / 100, date: out.date };
        },
      },
    },
  },
};

/**
 * Actions that only read. "Try once" runs these for real; every other action - anything that
 * sends, creates or changes something - is held back, so a new action is held back until it is
 * listed here.
 */
const READS = [['github', 'list_issues'], ['github', 'list_pulls'], ['github', 'latest_release'], ['github', 'get_file'], ['notion', 'search'], ['todoist', 'list_tasks'], ['trello', 'list_cards'], ['rss', 'read'], ['reddit', 'read'], ['hackernews', 'front_page'], ['hackernews', 'search'], ['wikipedia', 'summary'], ['wikipedia', 'search'], ['weather', 'forecast'], ['currency', 'convert']];
for (const [service, action] of READS) SERVICES[service].actions[action].reads = true;

/** Run one action of one service. `cred` is the decrypted credential, or null. */
export async function runService(config, params, { cred, fetch, signal }) {
  const service = SERVICES[config.service];
  const action = service?.actions[config.action];
  if (!action) throw fail('That service action does not exist');
  if (service.auth && !cred && (!service.authOptional || action.needsAuth)) throw fail(`Choose a ${CREDENTIAL_TYPES[service.auth].label} credential for this node`);
  return action.run({ p: params, cred, fetch, signal });
}

// -------------------------------------------------------- polling starts

/**
 * What can start a flow by being asked every few minutes. Each returns the newest
 * items as [{ key, data }]; `key` is what makes an item start the flow only once.
 * Like triggers, they only ask outward - nothing calls in.
 */
export const POLLERS = {
  rss: {
    label: 'New item in an RSS feed',
    fields: [f('url', 'Feed address', { placeholder: 'https://github.com/nodejs/node/releases.atom' })],
    run: async ({ c, fetch, signal }) => (await readFeed(fetch, httpsOrLocal(c.url, 'The feed address'), 20, signal)).map((item) => ({ key: item.id || item.link || item.title, data: item })),
  },
  reddit: {
    label: 'New post in a subreddit',
    every: 15, // Reddit answers 429 to feeds read too often
    fields: [f('subreddit', 'Subreddit', { placeholder: 'programming' })],
    run: async ({ c, fetch, signal }) => {
      const sub = String(c.subreddit ?? '').replace(/^\/?r\//, '').trim();
      if (!/^\w{2,21}$/.test(sub)) throw fail('Give the subreddit name, e.g. programming');
      return (await readFeed(fetch, `https://www.reddit.com/r/${sub}/new/.rss`, 25, signal)).map((item) => ({ key: item.id || item.link, data: item }));
    },
  },
  github: {
    label: 'New issue, pull request or release on GitHub',
    auth: 'github',
    fields: [f('repo', 'Repository', { placeholder: 'owner/name' }), f('event', 'issues, pulls or releases', { placeholder: 'issues' })],
    run: async ({ c, cred, fetch, signal }) => {
      const repo = repoOf(c.repo);
      const event = ['pulls', 'releases'].includes(c.event) ? c.event : 'issues';
      const path = event === 'releases' ? 'releases?per_page=10' : `${event}?state=open&sort=created&direction=desc&per_page=20`;
      const out = await request(fetch, `https://api.github.com/repos/${repo}/${path}`, { headers: github(cred), signal, name: 'GitHub' });
      if (event === 'releases') return out.map((r) => ({ key: String(r.id), data: { repo, tag: r.tag_name, name: r.name, url: r.html_url, published: r.published_at, notes: clip(r.body ?? '', 3000) } }));
      return out.filter((i) => event === 'pulls' || !i.pull_request).map((i) => ({ key: String(i.number), data: { repo, ...compactIssue(i) } }));
    },
  },
  hackernews: {
    label: 'New Hacker News story about something',
    fields: [f('query', 'Words to look for', { placeholder: 'local-first' })],
    run: async ({ c, fetch, signal }) => {
      const query = clip(String(c.query ?? ''), 200).trim();
      if (!query) throw fail('Say what to look for');
      const out = await request(fetch, `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=20&query=${encodeURIComponent(query)}`, { signal, name: 'Hacker News' });
      return out.hits.map((h) => ({ key: h.objectID, data: hnItem(h) }));
    },
  },
  watch: {
    label: 'An address answers something new',
    fields: [f('url', 'Address to check', { placeholder: 'https://api.example.com/status' })],
    run: async ({ c, cred, fetch, signal }) => {
      const headers = { 'user-agent': 'kadhai/1.0' };
      const url = applyCredential(cred, httpsOrLocal(c.url), headers);
      const data = await request(fetch, url, { headers, signal });
      const text = toText(data);
      // One item whose key is what the answer says: a new key means it changed.
      return [{ key: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16), data: typeof data === 'string' ? clip(data, 20000) : data }];
    },
  },
};

/** The catalog the browser draws its palette and forms from. Functions stay here. */
export function catalog() {
  const fields = (list) => list.map(({ id, label, placeholder, long, fixed, optional }) => ({ id, label, placeholder, long, fixed, optional }));
  return {
    services: Object.entries(SERVICES).map(([id, s]) => ({
      id,
      label: s.label,
      about: s.about ?? '',
      auth: s.auth ?? null,
      authOptional: Boolean(s.authOptional),
      checked: s.checked,
      actions: Object.entries(s.actions).map(([aid, a]) => ({ id: aid, label: a.label, needsAuth: Boolean(a.needsAuth), fields: fields(a.fields) })),
    })),
    credentials: Object.entries(CREDENTIAL_TYPES).map(([id, t]) => ({ id, label: t.label, help: t.help ?? '', canTest: Boolean(t.verify), fields: t.fields.map(({ id: fid, label, placeholder, secret, optional }) => ({ id: fid, label, placeholder, secret: Boolean(secret), optional: Boolean(optional) })) })),
    pollers: Object.entries(POLLERS).map(([id, p]) => ({ id, label: p.label, auth: p.auth ?? null, every: p.every ?? 10, fields: fields(p.fields) })),
  };
}
