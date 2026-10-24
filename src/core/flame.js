/**
 * Two ways to cook. The flame decides how much the crew may use per call, never which
 * models are allowed: any key works on either.
 *
 *   low  - the default, made for free tiers (about 8k tokens a minute): small prompts,
 *          short skills, one review round, free routes in their usual order.
 *   high - for paid models and subscriptions: longer skills, more file context, longer
 *          answers, a second review round, paid / subscription routes tried first, up to
 *          three steps at once, subscription CLIs working as agents on a copy of the folder,
 *          and a short recall of earlier work on each step's files.
 *
 * Every value is still a hard bound; high flame only moves the bounds. The low values are
 * the engine's own limits (env and test overrides apply to them), so low flame is exactly
 * what Kadhai always did.
 */
export const FLAMES = ['low', 'high'];

/** The caps that are not in config.limits from the start, at their low-flame values. */
export const LOW_EXTRAS = {
  skillsPerAgent: 3, // skills an agent's prompt carries
  skillChars: 900, // characters of each skill
  lessonLines: 5, // lessons in a prompt...
  lessonChars: 500, // ...and never more than this many characters of them
  historyChars: 2400, // what one look into the journal may add to the Chef's prompt
  toolsPerSubtask: 3, // connections one sub-task may name
  strongFirst: false, // walk the routes paid / subscription first
  flame: 'low', // its name, for reports
  rateWaits: 3, // waits for a rate-limited provider before a run gives up (maxRateWaitMs each, at most)
  securityReview: false, // one extra review, for security only, of a change touching sign-in, payments or personal data
  cliAgents: false, // a subscription CLI does a step as an agent, in a copy of the folder (cliAgent.js)
  agentTurns: 30, // ...for at most this many of its own turns
  agentTimeoutMs: 15 * 60000, // ...and this long
  parallelCooks: 1, // steps cooked at the same time (different cooks, different files)
  fileRecall: 0, // characters of "earlier work on these files" from the journal in a cook's prompt
  draftCalls: 2, // "describe a flow": calls to draw it (the first, plus retries told what was wrong)
  draftCatalogChars: 9000, // ...and how much of the services and connected tools its prompt lists
  flowAiTokens: 2000, // the longest answer an AI node in a flow may give
};

export const HIGH = {
  maxSubtasks: 10,
  maxReviewRounds: 2,
  maxToolRounds: 6,
  maxOutputTokens: 16000,
  fileContextChars: 80000,
  skillsPerAgent: 5,
  skillChars: 3000,
  lessonLines: 15,
  lessonChars: 1500,
  historyChars: 7200,
  toolsPerSubtask: 5,
  strongFirst: true,
  flame: 'high',
  securityReview: true,
  cliAgents: true,
  parallelCooks: 3,
  fileRecall: 1200,
  draftCalls: 3,
  draftCatalogChars: 30000,
  flowAiTokens: 8000,
  // Bigger prompts meet the free tiers' limits more often: wait more, and longer, rather than fail the run.
  maxRateWaitMs: 90000,
  rateWaits: 8,
};

/** The most skills an agent may have chosen: high flame's number; low flame uses the first few. */
export const MAX_SKILLS_CHOSEN = HIGH.skillsPerAgent;

export const cleanFlame = (value) => (FLAMES.includes(value) ? value : null);

/**
 * The limits for a flame. `base` is the engine's own (low-flame) limits; high flame never goes
 * below them, so an operator who raised a number in .env keeps it.
 */
export function limitsFor(flame, base) {
  const low = { ...LOW_EXTRAS, ...base };
  if (flame !== 'high') return low;
  const high = { ...low };
  for (const [key, value] of Object.entries(HIGH)) high[key] = typeof value === 'number' ? Math.max(value, low[key] ?? 0) : value;
  return high;
}
