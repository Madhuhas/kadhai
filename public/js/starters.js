import { $, toast } from './util.js';
import { emit } from './store.js';

/**
 * Ready-made requests for someone looking for a job, offered on the empty chat and in the command
 * palette. Each one only fills in the chat box (or opens a flow): nothing is sent until the person
 * has read it, filled in the [brackets] and pressed Send. The honesty rules are in the text itself,
 * so they hold whichever agent and model take the task.
 */

const AD = '[paste the job ad here]';

export const JOB_STARTERS = [
  {
    id: 'profile',
    label: 'Set up my job profile',
    hint: 'from your resume; the job alerts read it',
    attach: true,
    text: 'Read my attached resume and write job-profile.md: the roles I fit, my main skills, my years of experience, where I want to work (remote or a city), and what to leave out. Under 40 lines, only facts from the resume. The daily job alerts read this file.',
  },
  {
    id: 'tailor',
    label: 'Tailor my resume to a job',
    hint: 'attach your resume, paste the ad',
    attach: true,
    text: `Tailor my attached resume to the job below. Keep every fact true: reword, reorder and choose what to stress, but never add a skill, title, employer, date or number I do not have. Write it as a printable one-page HTML resume named after the company (resume-<company>.html). Also write notes-<company>.md listing what you changed and why, and which requirements of the job I do not meet, so I can prepare for them.\n\nThe job ad:\n${AD}`,
  },
  {
    id: 'letter',
    label: 'Write a cover letter',
    hint: 'attach your resume, paste the ad',
    attach: true,
    text: `Write a cover letter for the job below, from my attached resume: under 300 words, specific to this company and role, only facts from my resume, no cliches. Save it as a printable HTML page named cover-letter-<company>.html.\n\nThe job ad:\n${AD}`,
  },
  {
    id: 'portfolio',
    label: 'Build my portfolio site',
    hint: 'from your resume',
    attach: true,
    text: 'Build a one-page portfolio website (index.html with its CSS inline) from my attached resume: about, skills, experience, projects and contact. Use only facts from the resume, make it look good on a phone, and keep it fast (no frameworks, no images I did not give you).',
  },
  {
    id: 'practice',
    label: 'Practice for a coding interview',
    hint: 'problems with tests, no answers',
    text: 'Make me 3 practice coding interview problems for a [role, e.g. junior backend developer] role, easiest first. Each in its own folder (problem-1, problem-2, problem-3) with README.md (the problem, an example, the limits), solution.js with an empty function to fill in, and solution.test.js (node:test) that fails until it is solved. Do not write the solutions. When I ask you to check one, run its tests and tell me what is right and wrong.',
  },
  {
    id: 'questions',
    label: 'Prepare for an interview',
    hint: 'likely questions for one job',
    text: `Help me prepare for an interview for the job below. Write interview-prep.md with the 10 questions I am most likely to be asked (technical and about my experience), what a strong answer covers for each, and 3 good questions for me to ask them. If my resume is attached, point to my real experience for each answer; never invent any.\n\nThe job ad:\n${AD}`,
  },
  {
    id: 'tracker',
    label: 'Track my applications',
    hint: 'a page that keeps your list',
    text: 'Build me a job application tracker: tracker.html with its CSS and JavaScript inline, saving in the browser (localStorage). For each application: company, role, link, date applied, status (to apply, applied, interview, offer, rejected) and the next step with a date. Sort and filter by status, show counts per status, and export to CSV. It must work offline and on a phone.',
  },
  { id: 'alerts', label: 'Get job alerts every morning', hint: 'a flow: three job boards, filtered for you', flow: 'job-alerts' },
];

/** Put a starter into the chat box (or open its flow). The [brackets] are selected, ready to be typed over. */
export function useStarter(starter) {
  if (starter.flow) {
    emit('flowexample', starter.flow);
    return;
  }
  const box = $('#chat-input');
  box.value = starter.text;
  box.dispatchEvent(new Event('input'));
  box.focus();
  const at = starter.text.indexOf('[');
  if (at >= 0) box.setSelectionRange(at, starter.text.indexOf(']', at) + 1);
  else box.setSelectionRange(box.value.length, box.value.length);
  box.scrollTop = box.scrollHeight;
  if (starter.attach) toast('Attach your resume with + attach (PDF or Word), then press Send');
}
