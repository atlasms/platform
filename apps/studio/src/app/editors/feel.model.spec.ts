import { describe, expect, it } from 'vitest';
import { insertAt, judge, snippets } from './feel.model.ts';

// The judge is the contracts' own subset checker, run in the browser: these are the verdicts
// publish would give (DSL doc §3), not a second opinion.
describe('judge — what publish would say about an expression', () => {
  it('a blank field is no verdict at all; a legal one is clean', () => {
    expect(judge('', [])).toBeNull();
    expect(judge(' = ', [])).toBeNull();
    expect(judge('= vars.verdict = "approved"', ['verdict'])).toEqual({
      problem: null,
      undeclared: [],
    });
    expect(judge('= count(incoming.renditions) > 0 and steps.probe.ok', [])?.problem).toBeNull();
  });

  it('a construct outside the subset is named; a syntax error is a parse problem', () => {
    expect(judge('= for x in vars.xs return x', ['xs'])?.problem?.code).toBe('FEEL_SUBSET');
    expect(judge('= vars.a = ', ['a'])?.problem?.code).toBe('FEEL_PARSE');
    const root = judge('= asset.state = "ready"', [])?.problem;
    expect(root?.code).toBe('FEEL_SUBSET');
    expect(root?.message).toContain('vars, incoming, steps, instance');
  });

  it('a var the workflow does not declare is flagged — not a parse problem', () => {
    expect(judge('= vars.assetId != null and vars.typo', ['assetId'])).toEqual({
      problem: null,
      undeclared: ['typo'],
    });
  });
});

describe('snippets and insertion', () => {
  it('offers the roots, the declared vars and the allowed functions', () => {
    const offered = snippets(['assetId']).map((s) => s.label);
    expect(offered.slice(0, 5)).toEqual(['vars', 'incoming', 'steps', 'instance', 'vars.assetId']);
    expect(offered).toContain('count()');
    expect(offered).toContain('starts with()');
  });

  it('inserts at the caret, begins an empty expression with `= `, and spaces only where needed', () => {
    expect(insertAt('', 0, 0, 'vars.')).toEqual({ value: '= vars.', caret: 7 });
    expect(insertAt('= vars.a and', 12, 12, 'vars.b')).toEqual({
      value: '= vars.a and vars.b',
      caret: 19,
    });
    expect(insertAt('= count(', 8, 8, 'vars.xs')).toEqual({ value: '= count(vars.xs', caret: 15 });
    // A selection is replaced.
    expect(insertAt('= vars.old = 1', 2, 10, 'vars.new')).toEqual({
      value: '= vars.new = 1',
      caret: 10,
    });
  });
});
