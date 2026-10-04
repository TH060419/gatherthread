import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAnswer } from '../../ops/hosted-agent/public-answer.mjs';
const stream = (events) => events.map((e) => JSON.stringify(e)).join('\n');
test('hosted OpenCode JSON output shares assistant text only', () => {
  const events = [
    { type: 'reasoning', part: { id: 'r', type: 'reasoning', text: 'private thought' } },
    { type: 'tool_use', part: { id: 't', type: 'tool', state: { output: 'private tool output' } } },
    { type: 'text', part: { id: 'a', type: 'text', text: 'Done' } },
    { type: 'text', part: { id: 'a', type: 'text', text: 'Done, tests passed.' } },
  ];
  assert.equal(publicAnswer(stream(events)), 'Done, tests passed.');
  assert.throws(() => publicAnswer(stream(events.slice(0, 2))));
  assert.throws(() => publicAnswer(stream([...events, { type: 'error', error: 'secret error' }])));
  assert.throws(() => publicAnswer('unstructured private tool output'));
});
