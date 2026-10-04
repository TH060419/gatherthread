import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import test from 'node:test';
import { startCollaborationServer } from '../../apps/server/dist/src/server.js';
import { TestGateStore } from '../../apps/server/dist/src/test-gate.js';

const available = existsSync(new URL('../../apps/server/dist/src/registration.js', import.meta.url));
// Automatically becomes active when the separately reviewed PR62 dependency is merged.
test('PR62 dependency: admission then email accounts/recovery and native pairing remain isolated', { skip: available ? false : 'PR62 email accounts are not yet in main' }, async () => {
  const testOrigin = 'https://test.gatherthread.cn', prodOrigin = 'https://gatherthread.cn';
  const gate = { databasePath: ':memory:', pepper: randomBytes(32).toString('hex'), origin: testOrigin };
  // One in-memory admin/server store cannot be shared. Use a private on-disk fixture instead.
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gt-email-isolation-')));
  gate.databasePath = join(directory, 'admission.sqlite');
  const admin = new TestGateStore(gate), grant = admin.issue(1, 1)[0];
  const fixtures = await Promise.all([prodOrigin, testOrigin].map(async origin => {
    const mails = [];
    const registration = { enabled: true, recoveryEnabled: true, origin, siteKey: 'fixture',
      challenge: { async verify() { return true; } }, mailer: { async send(mail) { mails.push(mail); }, async notifyPasswordChanged(mail) { mails.push({ notice: true, ...mail }); } } };
    const server = await startCollaborationServer({ databasePath: ':memory:', authTokenPepper: randomBytes(32).toString('hex'), secureTransport: true,
      publicBaseUrl: origin, allowedOrigins: [origin], registration, ...(origin === testOrigin ? { testGate: gate } : {}) });
    const cookies = new Map();
    const call = (path, body, { native = false, token, omitAdmission = false, method } = {}) => new Promise((resolve, reject) => {
      const selected = [...cookies].filter(([key]) => !omitAdmission || !key.includes('test_gate')).map(([key, value]) => `${key}=${value}`).join('; ');
      const req = request(server.origin + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { host: new URL(origin).host,
        ...(native ? {} : { origin, cookie: selected }), ...(token ? { authorization: `${path.endsWith("/poll") ? "DSH-Pairing" : "Bearer"} ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }) } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
          if (!native) for (const raw of response.headers['set-cookie'] ?? []) { const pair = raw.split(';')[0]; const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
          const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, data: text ? JSON.parse(text).data : undefined });
        });
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { server, origin, mails, cookies, call };
  }));
  const [prod, preview] = fixtures;
  const email = 'same-mailbox@example.invalid', passwords = ['production fixture password', 'test fixture password'];
  const login = (f, password) => f.call('/v1/email-login', { email, password, device_name: 'Fixture web', remember_device: true });
  try {
    for (const path of ['/v1/registration', '/v1/password-reset', '/v1/email-login', '/%76%31/projects']) assert.equal((await preview.call(path)).status, 403);
    assert.equal((await preview.call('/v1/test-gate', { admission_code: grant.admission_code })).status, 200);
    for (const [i, f] of fixtures.entries()) {
      assert.equal((await f.call('/v1/registration')).status, 200);
      const sent = await f.call('/v1/registration/send', { email, locale: 'en', challenge_token: randomUUID(), idempotency_key: randomUUID() }); assert.equal(sent.status, 202);
      const done = await f.call('/v1/registration/verify', { registration_id: sent.data.registration_id, code: f.mails.at(-1).code,
        display_name: 'Fixture', device_name: 'Fixture web', remember_device: true, privacy_acknowledged: true, password: passwords[i] }); assert.equal(done.status, 201);
      assert.equal((await f.call('/v1/me')).status, 200);
      assert.equal((await login(f, passwords[1 - i])).status, 401);
    }
    assert.equal((await preview.call('/v1/me', undefined, { omitAdmission: true })).status, 403);
    const prodCookie = prod.cookies.get('__Host-gatherthread_session'), testCookie = preview.cookies.get('__Host-gatherthread_session');
    preview.cookies.set('__Host-gatherthread_session', prodCookie); assert.equal((await preview.call('/v1/me')).status, 401); preview.cookies.set('__Host-gatherthread_session', testCookie);
    prod.cookies.set('__Host-gatherthread_session', testCookie); assert.equal((await prod.call('/v1/me')).status, 401); prod.cookies.set('__Host-gatherthread_session', prodCookie);
    const authorization = await preview.call('/v1/device-authorizations', {}); assert.equal(authorization.status, 201);
    const crossClaim = await prod.call('/v1/device-authorizations/claim', { authorization_token: authorization.data.authorization_token, device_name: 'Fixture Codex' }, { native: true }); assert.equal(crossClaim.status, 401);
    const claimed = await preview.call('/v1/device-authorizations/claim', { authorization_token: authorization.data.authorization_token, device_name: 'Fixture Codex' }, { native: true }); assert.equal(claimed.status, 201);
    assert.equal((await preview.call('/v1/me', undefined, { native: true, token: claimed.data.token })).status, 200);
    assert.equal((await prod.call('/v1/me', undefined, { native: true, token: claimed.data.token })).status, 401);
    const pairing = await preview.call('/v1/dsh-pairings', { device_name: 'Fixture DSH' }, { native: true }); assert.equal(pairing.status, 201);
    assert.equal((await prod.call(`/v1/dsh-pairings/${pairing.data.pairing_id}/poll`, {}, { native: true, token: pairing.data.poll_token })).status, 401);
    assert.equal((await preview.call('/v1/dsh-pairings/approve', { user_code: pairing.data.user_code }, { omitAdmission: true })).status, 403);
    assert.equal((await preview.call('/v1/dsh-pairings/approve', { user_code: pairing.data.user_code })).status, 200);
    const paired = await preview.call(`/v1/dsh-pairings/${pairing.data.pairing_id}/poll`, {}, { native: true, token: pairing.data.poll_token }); assert.equal(paired.status, 201);
    assert.equal((await preview.call('/v1/me', undefined, { native: true, token: paired.data.token })).status, 200);
    assert.equal((await prod.call('/v1/me', undefined, { native: true, token: paired.data.token })).status, 401);
    assert.equal((await preview.call('/v1/password-reset')).status, 200);
    const sent = await preview.call('/v1/password-reset/send', { email, locale: 'en', challenge_token: randomUUID(), idempotency_key: randomUUID() }); assert.equal(sent.status, 202);
    const nextPassword = 'test changed fixture password';
    const reset = await preview.call('/v1/password-reset/verify', { reset_id: sent.data.reset_id, email, code: preview.mails.at(-1).code, password: nextPassword, password_confirmation: nextPassword, locale: 'en' }); assert.equal(reset.status, 200);
    assert.equal((await preview.call('/v1/me')).status, 401);
    assert.equal((await preview.call('/v1/me', undefined, { native: true, token: claimed.data.token })).status, 401);
    assert.equal((await preview.call('/v1/me', undefined, { native: true, token: paired.data.token })).status, 401);
    assert.equal((await prod.call('/v1/me')).status, 200);
    assert.equal((await login(preview, passwords[1])).status, 401); assert.equal((await login(preview, nextPassword)).status, 201);
    assert.equal((await login(prod, passwords[0])).status, 201);
    assert.equal((await preview.call('/v1/account', { confirmation: 'DELETE' }, { method: 'DELETE' })).status, 200);
    assert.equal((await preview.call('/v1/me')).status, 401); assert.equal((await prod.call('/v1/me')).status, 200);
  } finally { await Promise.all(fixtures.map(f => f.server.close())); admin.close(); rmSync(directory, { recursive: true, force: true }); }
});
