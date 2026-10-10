import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAnswer, publicSessionAnswer, sessionIsIdle } from '../../ops/hosted-agent/public-answer.mjs';
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

const reply = () => ({
  info: { id: 'msg_final', sessionID: 'ses_fixture', role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop' },
  parts: [
    { type: 'reasoning', text: 'private thought' },
    { type: 'tool', state: { output: 'private tool output' } },
    { id: 'synthetic', type: 'text', text: 'private synthetic', synthetic: true },
    { id: 'ignored', type: 'text', text: 'private ignored', ignored: true },
    { id: 'part_final', sessionID: 'ses_fixture', messageID: 'msg_final', type: 'text', text: 'Done' },
  ],
});

test('hosted prompt response requires authoritative completed assistant text, never hidden data', () => {
  assert.equal(publicSessionAnswer(reply(), 'ses_fixture'), 'Done');
  const truncated = reply(); truncated.info.finish = 'length';
  assert.equal(publicSessionAnswer(truncated, 'ses_fixture'), 'Done');
  const long = reply(); long.parts.at(-1).text = 'A'.repeat(20_000);
  assert.equal(publicSessionAnswer(long, 'ses_fixture').length, 14_000);
});

test('partial, tool-call, error, malformed and different-session replies never count as success', () => {
  for (const mutate of [
    (r) => delete r.info.time.completed,
    (r) => { r.info.time.completed = NaN; },
    (r) => { r.info.time.completed = 0; },
    (r) => { r.info.finish = 'tool-calls'; },
    (r) => { r.info.finish = undefined; },
    (r) => { r.info.role = 'user'; },
    (r) => { r.info.sessionID = 'ses_other'; },
    (r) => { r.info.error = { name: 'APIError', data: { message: 'private provider error' } }; },
    (r) => { r.parts.at(-1).messageID = 'msg_other'; },
    (r) => { r.parts.at(-1).sessionID = 'ses_other'; },
    (r) => { r.parts.at(-1).id = ''; },
    (r) => { r.parts.push({ ...r.parts.at(-1) }); },
    (r) => { r.parts.at(-1).text = ''; },
    (r) => { r.parts.pop(); },
  ]) {
    const input = reply(); mutate(input);
    assert.throws(() => publicSessionAnswer(input, 'ses_fixture'));
  }
  for (const input of [null, {}, [], { info: reply().info, parts: null }])
    assert.throws(() => publicSessionAnswer(input, 'ses_fixture'));
});

test('OpenCode removes its idle session from the status map; malformed or busy maps are not idle', () => {
  assert.equal(sessionIsIdle({}, 'ses_fixture'), true);
  assert.equal(sessionIsIdle({ ses_fixture: { type: 'idle' } }, 'ses_fixture'), true);
  assert.equal(sessionIsIdle({ ses_other: { type: 'busy' } }, 'ses_fixture'), true);
  for (const status of [null, [], 'idle', { ses_fixture: { type: 'busy' } },
    { ses_fixture: { type: 'retry', attempt: 1 } }, { ses_fixture: null }])
    assert.equal(sessionIsIdle(status, 'ses_fixture'), false);
});
