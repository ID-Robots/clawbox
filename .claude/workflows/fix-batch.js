export const meta = {
  name: 'fix-batch',
  description: 'Verify a list of findings with two refuters each, then fix the survivors in batches — per-item verdicts are returned in the result, findings are passed by file path, never sliced into a prompt',
  phases: [{ title: 'Verify' }, { title: 'Fix' }, { title: 'Integrate' }],
}
// args: { briefsPath: "/abs/path/to/findings.json", ids: ["F-02", ...], batchSize?: 8 }
// briefsPath must be a JSON array of { id, severity, title, evidence, fixBrief, redTest, siblingSites }.
// Scripts cannot read files — agents read briefsPath themselves; that is deliberate (no truncation possible here).
const ids = (args && args.ids) || []
const briefs = args && args.briefsPath
// batchSize must be a positive integer; anything else (negative, fractional, string, huge) falls back so the loop always terminates.
const rawBatch = Number(args && args.batchSize)
const batchSize = Number.isInteger(rawBatch) && rawBatch > 0 ? Math.min(rawBatch, 16) : 8
if (!briefs || !ids.length) throw new Error('fix-batch needs args { briefsPath, ids }')

const VERDICT = { type: 'object', required: ['refuted', 'confident', 'reason'], properties: { refuted: { type: 'boolean' }, confident: { type: 'boolean' }, reason: { type: 'string' }, correction: { type: 'string' } } }
const RESULT = { type: 'object', required: ['id', 'outcome', 'summary'], properties: { id: { type: 'string' }, outcome: { type: 'string', enum: ['MERGED', 'PR_OPEN', 'REFUTED', 'BLOCKED', 'FAILED'] }, pr: { type: 'integer' }, mergeSha: { type: 'string' }, summary: { type: 'string' }, unproven: { type: 'string' } } }
const LENSES = [
  ['real', 'IS IT REAL AND IS THE FIX RIGHT? Read the cited file:line on freshly fetched origin/beta; refute if beta already fixed it, if the evidence does not support the claim, or if the fix is wrong.'],
  ['scope', 'IS IT REALLY NO-DECISION AND IS THE BLAST RADIUS UNDERSTOOD? Refute if two competent engineers could disagree on what fixed looks like, if the fix could break the other edition or the dual SKU, or if the sibling-call-site list is obviously incomplete.'],
]

phase('Verify')
const verified = await pipeline(ids, (id) => parallel(LENSES.map(([key, angle]) => () =>
  agent('Verify the finding with id "' + id + '" in the JSON array at ' + briefs + ' (read the whole file, find your entry).\nYOUR LENS: ' + angle + '\nDefault to refuted=true when uncertain; confident=true only if you checked the code or the box yourself.',
    { label: 'verify:' + id + '/' + key, phase: 'Verify', agentType: 'clawbox-refuter', schema: VERDICT })))
  .then((vs) => {
    const live = vs.filter(Boolean)
    // Every lens must have returned a schema-valid verdict; a missing verifier is not a pass.
    const complete = live.length === LENSES.length
    const keep = complete && !live.some((v) => v.refuted && v.confident)
    return { id, keep, complete, verdicts: live, corrections: live.map((v) => v.correction).filter(Boolean).join('\n') }
  }))

const survivors = verified.filter(Boolean).filter((v) => v.keep)
const unverified = verified.filter(Boolean).filter((v) => !v.complete).map((v) => v.id)
if (unverified.length) log('NOT verified (a verifier returned nothing; treated as refuted): ' + unverified.join(', '))
log(survivors.length + ' of ' + ids.length + ' survive verification')

phase('Fix')
const outcomes = []
for (let i = 0; i < survivors.length; i += batchSize) {
  const batch = survivors.slice(i, i + batchSize)
  log('fix batch ' + (i / batchSize + 1) + ': ' + batch.map((v) => v.id).join(', '))
  const res = await parallel(batch.map((v) => () =>
    agent('Fix the finding with id "' + v.id + '" in the JSON array at ' + briefs + ' (read the whole file, find your entry).' + (v.corrections ? '\nCORRECTIONS FROM THE VERIFIERS — apply them:\n' + v.corrections : ''),
      { label: 'fix:' + v.id, phase: 'Fix', agentType: 'clawbox-fixer', schema: RESULT })))
  // A fixer that returned nothing (skipped, or died before reporting) still gets a per-item result.
  res.forEach((r, k) => outcomes.push(r || { id: batch[k].id, outcome: 'FAILED', summary: 'fixer returned no result (skipped or died before reporting)' }))
}

phase('Integrate')
// Fixers stop at PR_OPEN. Merges happen here, one at a time, each rebased on the beta the previous merge produced,
// so no merge can invalidate another PR's rebase or CI result.
const INTEGRATED = { type: 'object', required: ['id', 'outcome', 'summary'], properties: { id: { type: 'string' }, outcome: { type: 'string', enum: ['MERGED', 'PR_OPEN', 'FAILED'] }, pr: { type: 'integer' }, mergeSha: { type: 'string' }, summary: { type: 'string' } } }
for (const o of outcomes) {
  if (o.outcome !== 'PR_OPEN' || !o.pr) continue
  const r = await agent('Integrate PR #' + o.pr + ' (finding ' + o.id + ') into beta, alone. Read CLAUDE.md → Working rules first. Steps: fetch; if the PR branch is behind origin/beta, rebase it onto origin/beta in its worktree (../clawbox-wt-' + o.id + ' if present, otherwise a fresh worktree) and push with --force-with-lease to the PR branch only; wait for CI and CodeRabbit to be green and addressed; merge with a merge commit; remove the worktree. Outcome MERGED with the merge SHA; PR_OPEN if CI is still red after one honest attempt to fix it; FAILED if the merge cannot happen. Never touch beta or main directly.',
    { label: 'integrate:' + o.id, phase: 'Integrate', schema: INTEGRATED })
  if (r) Object.assign(o, r)
  else o.summary += ' | integrator returned no result; PR left open'
}

return {
  verdicts: verified.filter(Boolean).map((v) => ({ id: v.id, keep: v.keep, verdicts: v.verdicts })),
  outcomes,
  merged: outcomes.filter((o) => o.outcome === 'MERGED').length,
}
