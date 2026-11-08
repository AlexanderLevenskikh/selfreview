import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../evaluation/workflow/run.mjs';

test('registered workflow acceptance covers scope, lifecycle, source drift, diff and baseline boundaries', async () => {
  const report = await runWorkflow({ label: 'automated-acceptance', reference: 'working tree' });
  const gaps = report.cases.filter(item => item.outcome !== 'PASS').map(item => ({
    id: item.id, outcome: item.outcome, observed: item.observed,
    mismatches: item.mismatches, reason: item.reason, error: item.error,
  }));
  assert.equal(report.implementation.stableDuringRun, true, 'Implementation changed during acceptance');
  assert.deepEqual(gaps, [], JSON.stringify(gaps, null, 2));
  assert.deepEqual(report.counts, { total: 17, passed: 17, failed: 0, notAvailable: 0, errors: 0 });
  assert.equal(report.status, 'ALL_DECLARED_CASES_MET');
});
