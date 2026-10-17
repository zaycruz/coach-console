export const meta = {
  name: 'persona-feedback',
  description: 'Simulated clinicians use the deployed Patient 360 in a real browser and give feedback; one synthesis ranks it',
  whenToUse: 'At the end of every iteration release. args: {base, stamp}',
  phases: [{ title: 'Use the app', detail: 'one Claude agent per persona, headless Playwright' }, { title: 'Synthesize', detail: 'rank feedback into next-iteration items' }],
}
// Run: Workflow({scriptPath: '<repo>/scripts/persona-feedback.workflow.js', args: {base: 'https://patient-360.raava.dev', stamp: '2026-10-17T16-00'}})
const BASE = (args && args.base) || 'https://patient-360.raava.dev'
const STAMP = (args && args.stamp) || 'latest'
const REPO = '/Users/master/projects/emerge-hackathon/coach-console'
const OUT = `${REPO}/runs/feedback-${STAMP}`

const PERSONAS = [
  { key: 'coach', who: 'Marisol, a bilingual (English/Spanish) health coach at a cancer survivorship program. She does 12 to 15 phone calls a day. She is comfortable with apps but impatient with clutter.',
    job: 'Start your day: find who needs a call today and why. Open the top patient, read the recap of the last conversation and the insight, then start a call. Record yourself speaking: use the mic with a fake audio file (see BROWSER) and also type a few lines as coach and as patient. End and save the call, then confirm it shows as the latest recap. Play one demo call as live. Judge whether you could run a real call with this.' },
  { key: 'carelead', who: 'Dr. Okafor, an oncology nurse practitioner who leads the care team. He worries about ER visits and hospital admissions. He is data-literate and skeptical of black-box scores.',
    job: 'Find the patients at highest risk of the hospital. Open several from the Hospital risk list, drill into why the risk is high, and check whether you trust the model: look at AUROC, fairness and caveats. Look for any data that seems lost or contradictory between the Health chart and the program tabs.' },
  { key: 'navigator', who: 'Jen, a nurse navigator who juggles many patients across programs. She lives in keyboard shortcuts and hates hunting through menus.',
    job: 'Use the AI assistant as your main way around. Ask who is most at risk, then ask it to open the first one, then ask it to start a call with them. Ask what is on this page, ask about a specific patient\'s glucose, and ask a general medical question. Test follow-ups ("that one", "the second patient") and closing and reopening the AI assistant. Judge whether it saves you time or wastes it.' },
  { key: 'judge', who: 'Priya, a clinical informaticist judging a healthcare hackathon. She has 5 minutes, opens the app on her phone first and then on a laptop, and asks "would a clinic actually use this?"',
    job: 'Use the app at phone width (390x844) and then desktop. Form a first impression within 30 seconds, find the most impressive thing and the most confusing thing, check that the language is clinician-facing and consistent, and check that it feels trustworthy: synthetic-data labels, AI labels, nothing broken.' },
]

const prompt = (p) => `You are a simulated user in a feedback session for a clinician-facing web app, Patient 360. It's deployed at ${BASE}. It brings a cancer-survivorship care team's programs together in one record: hospital risk (C1), rough weeks from wearables (C3), glucose (C4) and coaching calls (C5). All data is synthetic.
PERSONA: ${p.who}
YOUR JOB TODAY: ${p.job}
BROWSER: drive the real deployed app with Playwright (headless Chromium). Write small Node ESM scripts in ${OUT}/${p.key}/. That folder sits inside the repo, so 'import { chromium } from "playwright"' resolves. Run each with node, take screenshots into the same folder, and read them with the Read tool so you SEE the page as a user would. Each script ends its browser; leave no process running. For the mic, launch Chromium with args ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture=<wav>'] and grant the 'microphone' permission. Make the wav with: say -o x.aiff "<what you would say>" && afconvert -f WAVE -d LEI16@16000 x.aiff x.wav.
RULES: You are a user, not a developer. Do NOT read the app source code or the repo docs; learn the app only by using it. Do not edit any file outside ${OUT}/${p.key}/. Work for real: aim for 15 to 30 browser actions and at least 6 screenshots. Stay in character when you judge.
Return feedback in the persona's own voice, plus concrete evidence: the steps you took and the screenshot paths.`

const FEEDBACK = { type: 'object', properties: {
  persona: { type: 'string' },
  verdict: { type: 'string', description: 'one sentence, in character: would you use this tomorrow?' },
  score: { type: 'number', description: '1-10 overall' },
  worked: { type: 'array', items: { type: 'string' } },
  issues: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'] },
    where: { type: 'string', description: 'route or screen' }, steps: { type: 'string' }, evidence: { type: 'string', description: 'screenshot path(s)' },
    suggestion: { type: 'string' } }, required: ['title', 'severity', 'where', 'steps', 'suggestion'] } },
  wishes: { type: 'array', items: { type: 'string' } },
}, required: ['persona', 'verdict', 'score', 'worked', 'issues', 'wishes'] }

phase('Use the app')
const fb = (await parallel(PERSONAS.map((p) => () => agent(prompt(p), { label: `persona: ${p.key}`, phase: 'Use the app', schema: FEEDBACK })))).filter(Boolean)
log(`${fb.length}/${PERSONAS.length} personas reported`)

phase('Synthesize')
const synthesis = await agent(`Below is feedback from ${fb.length} simulated clinicians who used Patient 360 (${BASE}).
${JSON.stringify(fb, null, 1)}
Merge duplicate issues across personas and rank them by impact on a live hackathon demo: blockers first, then issues several personas hit. Before you rank a blocker or major issue, open its evidence screenshots with the Read tool to confirm it. Drop anything you can't confirm, and say what you dropped. Write ${OUT}/FEEDBACK.md: the scores table, then the ranked issues (each with title, severity, the personas who hit it, steps, evidence, suggested fix), then what worked, then the wishes. Return the same ranked list.`, { label: 'synthesize', phase: 'Synthesize', schema: { type: 'object', properties: {
  ranked: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string' }, personas: { type: 'array', items: { type: 'string' } }, fix: { type: 'string' } }, required: ['title', 'severity', 'personas', 'fix'] } },
  dropped: { type: 'array', items: { type: 'string' } }, report: { type: 'string' } }, required: ['ranked', 'dropped', 'report'] } })
return { scores: fb.map((f) => ({ persona: f.persona, score: f.score, verdict: f.verdict })), synthesis }
