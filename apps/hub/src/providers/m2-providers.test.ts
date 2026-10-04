import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DECISION_THRESHOLDS } from '@idearelay/contracts';
import { createMockDecisionProvider } from './decision/mock.js';
import { createJevDecisionProvider, JEV_DEFAULT_ENDPOINT, parseJevResult } from './decision/jev.js';
import { createMockModelProvider, renderMockSummary } from './model/mock.js';
import { parseChatCompletion } from './model/openai.js';

test('mock decision: cue → high confidence kind; no cue → low confidence unknown', async () => {
  const provider = createMockDecisionProvider();
  const kinds = ['requirement', 'idea', 'log', 'task', 'reference', 'question', 'unknown'];
  const clear = await provider.decide({
    primitive: 'choice',
    question: '把这段转写归入下面哪个顶层类目\n我们需要支持这个功能',
    options: kinds,
  });
  assert.equal(clear.choice, 'requirement');
  assert.equal(clear.confidence, 0.9);
  assert.equal(clear.abstained, false);

  const vague = await provider.decide({
    primitive: 'choice',
    question: '把这段转写归入下面哪个顶层类目\n嗯，随便说点什么',
    options: kinds,
  });
  assert.equal(vague.choice, 'unknown');
  assert.equal(vague.confidence, 0.4);
});

test('mock decision: abstainOnNoMatch / alwaysAbstain force abstention', async () => {
  const abstaining = createMockDecisionProvider({ abstainOnNoMatch: true });
  const r1 = await abstaining.decide({
    primitive: 'choice',
    question: 'no cues here',
    options: ['requirement', 'unknown'],
  });
  assert.equal(r1.abstained, true);

  const forced = createMockDecisionProvider({ alwaysAbstain: true });
  const r2 = await forced.decide({
    primitive: 'choice',
    question: '需要支持',
    options: ['requirement', 'unknown'],
  });
  assert.equal(r2.confidence, 0.9, 'abstention is not low confidence');
  assert.equal(r2.abstained, true);
});

test('mock decision: per-call thresholdOverrides change certainty and noul band', async () => {
  const provider = createMockDecisionProvider();
  const base = await provider.decide({
    primitive: 'choice',
    question: '需要支持',
    options: ['requirement', 'unknown'],
  });
  assert.equal(base.certainty, 'high');

  const raised = await provider.decide({
    primitive: 'choice',
    question: '需要支持',
    options: ['requirement', 'unknown'],
    thresholdOverrides: { high: 0.95 },
  });
  assert.equal(raised.confidence, 0.9);
  assert.equal(raised.certainty, 'medium', 'raised high threshold demotes certainty');

  const band = createMockDecisionProvider({ highConfidence: 0.9 });
  const notBand = await band.decide({ primitive: 'noul', question: '需要支持' });
  assert.equal(notBand.abstained, false, '0.9 outside default [0.35,0.65]');
  const inBand = await band.decide({
    primitive: 'noul',
    question: '需要支持',
    thresholdOverrides: { noulBand: [0.8, 0.95] },
  });
  assert.equal(inBand.abstained, true, '0.9 inside overridden band');
});

test('jev: request pins the model and merges per-call threshold overrides', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | undefined }> = [];
  const provider = createJevDecisionProvider({
    model: 'jev-pinned-1',
    apiKey: 'secret',
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: headers.authorization,
      });
      return new Response(
        JSON.stringify({
          primitive: 'choice',
          probabilities: { requirement: 0.86, unknown: 0.14 },
          confidence: 0.86,
          certainty: 'high',
          needs_escalation: false,
          model_version: 'jev-pinned-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const result = await provider.decide({
    primitive: 'choice',
    question: 'classify',
    options: ['requirement', 'unknown'],
    thresholdOverrides: { high: 0.7, noulBand: [0.4, 0.6] },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_DEFAULT_ENDPOINT);
  assert.equal(calls[0].auth, 'Bearer secret');
  assert.equal(calls[0].body.model, 'jev-pinned-1', 'model pinned, not an alias');
  assert.deepEqual(calls[0].body.thresholds, {
    confidence_high: 0.7,
    confidence_low: DEFAULT_DECISION_THRESHOLDS.low,
    noul_band: [0.4, 0.6],
  });
  assert.equal(result.choice, 'requirement');
  assert.equal(result.confidence, 0.86);
  assert.equal(result.abstained, false);
  assert.equal(result.modelVersion, 'jev-pinned-1');
});

test('jev: parseJevResult maps a sparse response and falls back to thresholds', () => {
  const parsed = parseJevResult(
    { probabilities: { a: 0.2, b: 0.8 }, model: 'm1' },
    { primitive: 'choice', question: 'q', options: ['a', 'b'] },
    'm-pinned',
    DEFAULT_DECISION_THRESHOLDS,
  );
  assert.equal(parsed.choice, 'b', 'choice falls back to the top probability');
  assert.equal(parsed.confidence, 0.8, 'confidence falls back to choice probability');
  assert.equal(parsed.certainty, 'high');
  assert.equal(parsed.modelVersion, 'm1');
});

test('model: mock summaries are deterministic; openai parser is tolerant', async () => {
  const mock = createMockModelProvider();
  const a = await mock.complete({ model: 'mock-model-v1', messages: [{ role: 'user', content: 'hello world' }] });
  const b = await mock.complete({ model: 'mock-model-v1', messages: [{ role: 'user', content: 'hello world' }] });
  assert.equal(a.text, b.text);
  assert.equal(a.text, renderMockSummary('hello world'));
  assert.equal(a.model, 'mock-model-v1');

  const parsed = parseChatCompletion(
    { choices: [{ message: { content: 'sum' } }], model: 'gpt-x', usage: { prompt_tokens: 3, completion_tokens: 4 } },
    'fallback',
  );
  assert.deepEqual(parsed, { text: 'sum', model: 'gpt-x', usage: { promptTokens: 3, completionTokens: 4 } });

  assert.equal(parseChatCompletion({}, 'fallback').text, '');
});
