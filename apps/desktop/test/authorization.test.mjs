import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAuthorization, validateClaim } from '../src/authorization.mjs';
const link = { version: '2', origin: 'https://test.gatherthread.cn', authorizationId: 'authorization-fixture', project: 'project-fixture', email: 'fixture@example.invalid' };
const fixture = () => ({ data: { token: `gta_${'a'.repeat(43)}`, actor: { user_id: 'fixture-user', device_id: 'fixture-device', display_name: 'Fixture' },
  device: { id: 'fixture-device', user_id: 'fixture-user', name: 'Fixture Mac', created_at: '2026-10-01T00:00:00Z',
    token_created_at: '2026-10-01T00:00:00Z', last_used_at: null, expires_at: null, revoked_at: null, rotated_at: null, token_version: 1 },
  authorization: { id: 'authorization-fixture', user_id: 'fixture-user', authorizer_device_id: 'fixture-browser',
    claimed_by_device_id: 'fixture-device', created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-01T00:10:00Z',
    claimed_at: '2026-10-01T00:01:00Z', revoked_at: null, expired_at: null } } });
test('authorization uses exact origin, private JSON body and no redirect or browser cookies', async () => {
  const token = await claimAuthorization(link, 'fictional-password', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://test.gatherthread.cn/v1/codex-launcher-authorizations/claim');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Origin, undefined);
    assert.equal(JSON.parse(options.body).password, 'fictional-password');
    return new Response(JSON.stringify(fixture()), { status: 201 });
  } }); assert.equal(token, fixture().data.token);
});
test('malformed, cross-user, revoked and wrong-handoff responses fail closed', () => {
  for (const mutate of [v => { v.data.actor.device_id = 'foreign'; }, v => { v.data.authorization.id = 'another'; },
    v => { v.data.device.revoked_at = '2026-10-01T00:02:00Z'; }, v => { v.data.token = 'not-a-token'; },
    v => { v.data.device.token_version = true; }, v => { v.data.authorization.expired_at = '2026-10-01T00:02:00Z'; }]) {
    const v = fixture(); mutate(v); assert.throws(() => validateClaim(v, link), { code: 'authorization_uncertain' });
  }
});
test('oversized response and raw server errors do not escape as diagnostics', async () => {
  await assert.rejects(claimAuthorization(link, 'fictional-password', { fetchImpl: async () => new Response('x'.repeat(20_000), { status: 201 }) }), { code: 'authorization_uncertain' });
  await assert.rejects(claimAuthorization(link, 'fictional-password', { fetchImpl: async () => new Response('SECRET-provider-error', { status: 500 }) }), { code: 'authorization_uncertain' });
});
test('aborting an authorization discards even a late successful result', async () => {
  const controller = new AbortController();
  await assert.rejects(claimAuthorization(link, 'fictional-password', { signal: controller.signal,
    fetchImpl: async () => { controller.abort(); return new Response(JSON.stringify(fixture()), { status: 201 }); } }), { code: 'cancelled' });
});
test('uncertain authorization is attempted only once', async () => {
  let count = 0;
  await assert.rejects(claimAuthorization(link, 'fictional-password', { fetchImpl: async () => { count++; throw new Error('sensitive'); } }), { code: 'authorization_uncertain' });
  assert.equal(count, 1);
});
