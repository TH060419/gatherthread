/**
 * Contract implemented by E2E drivers.
 *
 * createUser(label) -> { id, token }
 * createSession({ owner, mode }) -> { id, mode, lastSequence }
 * addMember({ session, actor, user, role }) -> void
 * connectClient({ session, user, afterSequence? }) -> Client
 * registerRuntime({ user, deviceId, harness, provider, model, localSessionId }) -> Runtime
 * claimRequest({ runtime, requestId }) -> { request, canonicalHistory }
 * completeClaim({ runtime, requestId, content, idempotencyKey }) -> Event
 * commitLocalTurn({ session, runtime, localTurnId, basedOnSequence, request, response })
 *   -> { headBeforeCommit, reconciliationRequired, requestEvent, responseEvent }
 * listEvents({ session, afterSequence? }) -> Event[]
 * close() -> void
 *
 * Client:
 *   append({ type, payload, idempotencyKey, replyTo? }) -> Event
 *   nextEvent({ timeoutMs? }) -> Event
 *   replay({ afterSequence }) -> Event[]
 *   disconnect() -> void
 *
 * Rejections must expose a stable `error.code`. Required codes are:
 * `forbidden`, `claim_not_owned`, `runtime_busy`, `already_completed`,
 * `idempotency_conflict`, and `disconnected`.
 */
export const REQUIRED_DRIVER_METHODS = [
  'createUser',
  'createSession',
  'addMember',
  'connectClient',
  'registerRuntime',
  'claimRequest',
  'completeClaim',
  'commitLocalTurn',
  'listEvents',
  'close',
]

export function assertDriverShape(driver) {
  for (const method of REQUIRED_DRIVER_METHODS) {
    if (typeof driver?.[method] !== 'function') {
      throw new TypeError(`E2E driver is missing method: ${method}`)
    }
  }
  return driver
}
