export const meta = {
  name: 'fix-batch',
  description: 'Verify a list of findings with two refuters each, then fix the survivors in batches — per-item verdicts are returned in the result, findings are passed by file path, never sliced into a prompt',
  phases: [{ title: 'Verify' }, { title: 'Fix' }],
}
// args: { briefsPath: "/abs/path/to/findings.json", ids: ["F-02", ...], batchSize?: 8 }
// briefsPath must be a JSON array of { id, severity, title, evidence, fixBrief, redTest, siblingSites }.
// Scripts cannot read files — agents read briefsPath themselves; that is deliberate (no truncation possible here).
const ids = (args && args.ids) || []
const briefs = args && args.briefsPath
const batchSize = (args && args.batchSize) || 8
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
  .then((vs) => { const live = vs.filter(Boolean); return { id, keep: !live.some((v) => v.refuted && v.confident), verdicts: live, corrections: live.map((v) => v.correction).filter(Boolean).join('\n') } }))

const survivors = verified.filter(Boolean).filter((v) => v.keep)
log(survivors.length + ' of ' + ids.length + ' survive verification')

phase('Fix')
const outcomes = []
for (let i = 0; i < survivors.length; i += batchSize) {
  const batch = survivors.slice(i, i + batchSize)
  log('fix batch ' + (i / batchSize + 1) + ': ' + batch.map((v) => v.id).join(', '))
  const res = await parallel(batch.map((v) => () =>
    agent('Fix the finding with id "' + v.id + '" in the JSON array at ' + briefs + ' (read the whole file, find your entry).' + (v.corrections ? '\nCORRECTIONS FROM THE VERIFIERS — apply them:\n' + v.corrections : ''),
      { label: 'fix:' + v.id, phase: 'Fix', agentType: 'clawbox-fixer', schema: RESULT })))
  outcomes.push(...res.filter(Boolean))
}
return {
  verdicts: verified.filter(Boolean).map((v) => ({ id: v.id, keep: v.keep, verdicts: v.verdicts })),
  outcomes,
  merged: outcomes.filter((o) => o.outcome === 'MERGED').length,
}
