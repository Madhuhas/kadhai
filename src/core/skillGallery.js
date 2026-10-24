/**
 * A short, hand-picked list of skills worth importing, shown in the new-skill form. Each one is
 * an ordinary import (skillImport.js): fetched when picked, condensed if long, read by the user
 * before it is saved. All come from github.com/wshobson/agents (MIT licence).
 *
 * Checked on 2026-10-14: every address answered 200 with a SKILL.md. Add entries only after
 * checking them the same way - a link from memory may not exist.
 */
const REPO = 'https://github.com/wshobson/agents/tree/main/plugins';
const at = (plugin, skill) => `${REPO}/${plugin}/skills/${skill}`;

export const SKILL_GALLERY = [
  { group: 'Python', name: 'Python testing (pytest)', url: at('python-development', 'python-testing-patterns') },
  { group: 'Python', name: 'Async Python', url: at('python-development', 'async-python-patterns') },
  { group: 'Python', name: 'FastAPI projects', url: at('api-scaffolding', 'fastapi-templates') },
  { group: 'JavaScript & TypeScript', name: 'JavaScript testing (Jest, Vitest)', url: at('javascript-typescript', 'javascript-testing-patterns') },
  { group: 'JavaScript & TypeScript', name: 'Node.js back ends', url: at('javascript-typescript', 'nodejs-backend-patterns') },
  { group: 'JavaScript & TypeScript', name: 'Advanced TypeScript types', url: at('javascript-typescript', 'typescript-advanced-types') },
  { group: 'Front end', name: 'React state management', url: at('frontend-mobile-development', 'react-state-management') },
  { group: 'Front end', name: 'Next.js App Router', url: at('frontend-mobile-development', 'nextjs-app-router-patterns') },
  { group: 'Front end', name: 'Tailwind design systems', url: at('frontend-mobile-development', 'tailwind-design-system') },
  { group: 'APIs & data', name: 'API design (REST, GraphQL)', url: at('backend-development', 'api-design-principles') },
  { group: 'APIs & data', name: 'PostgreSQL table design', url: at('database-design', 'postgresql-table-design') },
  { group: 'APIs & data', name: 'SQL query speed', url: at('developer-essentials', 'sql-optimization-patterns') },
  { group: 'APIs & data', name: 'Sign-in and permissions', url: at('developer-essentials', 'auth-implementation-patterns') },
  { group: 'Testing & debugging', name: 'End-to-end tests (Playwright)', url: at('developer-essentials', 'e2e-testing-patterns') },
  { group: 'Testing & debugging', name: 'Debugging strategies', url: at('developer-essentials', 'debugging-strategies') },
  { group: 'Shell', name: 'Safe Bash scripts', url: at('shell-scripting', 'bash-defensive-patterns') },
];
