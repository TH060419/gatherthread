import { fail } from './policy.mjs';

function date(value, nullable = false) {
  return nullable && value === null || typeof value === 'string' && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}
const identity = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128;
export function validateClaim(value, link) {
  const d = value?.data, a = d?.actor, device = d?.device, authorization = d?.authorization;
  if (!identity(a?.user_id) || !identity(a?.device_id) || device?.id !== a.device_id || device.user_id !== a.user_id
    || typeof a.display_name !== 'string' || !a.display_name.length || a.display_name.length > 120
    || typeof device.name !== 'string' || !device.name.length || device.name.length > 120
    || !date(device.created_at) || !date(device.token_created_at)
    || !['last_used_at', 'expires_at', 'revoked_at', 'rotated_at'].every(k => date(device[k], true))
    || !Number.isSafeInteger(device.token_version) || device.token_version < 1 || device.revoked_at !== null
    || authorization?.id !== link.authorizationId || authorization.user_id !== a.user_id
    || !identity(authorization.authorizer_device_id) || authorization.claimed_by_device_id !== device.id
    || !date(authorization.created_at) || !date(authorization.expires_at) || !date(authorization.claimed_at)
    || authorization.revoked_at !== null || authorization.expired_at !== null
    || !/^gta_[A-Za-z0-9_-]{43}$/u.test(d.token ?? '')) fail('authorization_uncertain');
  return d.token;
}
export async function claimAuthorization(link, password, { signal, fetchImpl = fetch } = {}) {
  if (!['2', '3'].includes(link.version) || typeof password !== 'string' || password.length < 8
    || password.length > 128 || Buffer.byteLength(password) > 512) fail('invalid_request');
  const timeout = AbortSignal.timeout(15_000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(`${link.origin}/v1/codex-launcher-authorizations/claim`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: combined,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization_id: link.authorizationId, project_id: link.project,
        email: link.email, password, device_name: 'macOS · GatherThread Desktop' }),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      fail(response.status === 401 ? 'authorization_failed' : response.status === 429 ? 'rate_limited' : 'authorization_uncertain');
    }
    if (Number(response.headers.get('content-length')) > 16_384) { await response.body?.cancel(); fail('authorization_uncertain'); }
    const reader = response.body?.getReader(); if (!reader) fail('authorization_uncertain');
    const chunks = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 16_384) fail('authorization_uncertain'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    if (combined.aborted) fail(signal?.aborted ? 'cancelled' : 'authorization_uncertain');
    return validateClaim(JSON.parse(Buffer.concat(chunks).toString('utf8')), link);
  } catch (error) {
    if (signal?.aborted) fail('cancelled');
    if (['authorization_failed', 'rate_limited', 'authorization_uncertain'].includes(error.code)) throw error;
    fail('authorization_uncertain');
  }
}
