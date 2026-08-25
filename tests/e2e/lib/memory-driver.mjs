import { randomUUID } from 'node:crypto'

const REDACTED = '[REDACTED]'
const EXCLUDED = '[EXCLUDED_BY_POLICY]'
const sensitiveKeys = /^(authorization|cookie|password|passwd|secret|token|access_token|refresh_token|api[_-]?key)$/i
const credentialPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}\b/g,
]

class ContractError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function redactString(value) {
  return credentialPatterns.reduce((result, pattern) => result.replace(pattern, REDACTED), value)
}

function redact(value, key = '') {
  if (sensitiveKeys.test(key)) return REDACTED
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !entry || !['system', 'developer'].includes(entry.role))
      .map((entry) => redact(entry))
  }
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/^(thinking|raw_thinking|private_instructions)$/i.test(childKey)) {
      result[childKey] = EXCLUDED
    } else {
      result[childKey] = redact(childValue, childKey)
    }
  }
  return result
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export function createDriver() {
  const sessions = new Map()
  const runtimes = new Map()
  const clients = new Set()

  function getSession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) throw new ContractError('not_found', 'session not found')
    return session
  }

  function roleFor(session, userId) {
    return session.members.get(userId)
  }

  function publish(session, event) {
    for (const client of clients) {
      if (client.connected && client.session.id === session.id && client.cursor < event.sequence) {
        client.queue.push(event)
        client.cursor = event.sequence
        client.flush()
      }
    }
  }

  function appendCommitted({ session, user, type, payload, idempotencyKey, replyTo, runtime }) {
    if (!idempotencyKey) throw new ContractError('invalid_input', 'idempotencyKey is required')
    const role = roleFor(session, user.id)
    if (!role) throw new ContractError('forbidden', 'membership required')
    if (role === 'viewer' || (session.mode === 'solo' && user.id !== session.ownerId)) {
      throw new ContractError('forbidden', 'role cannot append')
    }

    const sanitizedPayload = redact(structuredClone(payload ?? {}))
    const existing = session.idempotency.get(idempotencyKey)
    if (existing) {
      const sameOperation = existing.actor.userId === user.id
        && existing.type === type
        && existing.replyTo === (replyTo ?? null)
        && JSON.stringify(existing.payload) === JSON.stringify(sanitizedPayload)
      if (!sameOperation) {
        throw new ContractError('idempotency_conflict', 'key was already used for a different operation')
      }
      return existing
    }

    const event = Object.freeze({
      id: randomUUID(),
      sessionId: session.id,
      sequence: session.events.length + 1,
      idempotencyKey,
      actor: { userId: user.id },
      timestamp: new Date().toISOString(),
      visibility: 'session',
      replyTo: replyTo ?? null,
      type,
      payload: sanitizedPayload,
      runtime: runtime ? structuredClone(runtime.provenance) : null,
    })
    session.events.push(event)
    session.idempotency.set(idempotencyKey, event)
    publish(session, event)
    return event
  }

  return {
    async createUser(label) {
      return Object.freeze({ id: randomUUID(), token: randomUUID(), label })
    },

    async createSession({ owner, mode }) {
      if (!['solo', 'multi'].includes(mode)) throw new ContractError('invalid_input', 'invalid mode')
      const session = {
        id: randomUUID(),
        mode,
        ownerId: owner.id,
        members: new Map([[owner.id, 'owner']]),
        events: [],
        idempotency: new Map(),
        localTurns: new Map(),
        completedRequestIds: new Set(),
      }
      sessions.set(session.id, session)
      return { id: session.id, mode, lastSequence: 0 }
    },

    async addMember({ session, actor, user, role }) {
      const state = getSession(session.id)
      if (actor.id !== state.ownerId) throw new ContractError('forbidden', 'only owner manages members')
      if (!['participant', 'viewer'].includes(role)) throw new ContractError('invalid_input', 'invalid role')
      state.members.set(user.id, role)
    },

    async connectClient({ session, user, afterSequence = 0 }) {
      const state = getSession(session.id)
      if (!roleFor(state, user.id)) throw new ContractError('forbidden', 'membership required')
      const client = {
        session: state,
        user,
        connected: true,
        cursor: afterSequence,
        queue: state.events.filter((event) => event.sequence > afterSequence),
        waiters: [],
        flush() {
          while (this.connected && this.queue.length && this.waiters.length) {
            this.waiters.shift().resolve(this.queue.shift())
          }
        },
        async append(input) {
          if (!this.connected) throw new ContractError('disconnected', 'client is disconnected')
          return appendCommitted({ session: state, user, ...input })
        },
        async nextEvent({ timeoutMs = 1_000 } = {}) {
          if (!this.connected) throw new ContractError('disconnected', 'client is disconnected')
          if (this.queue.length) return this.queue.shift()
          const waiter = deferred()
          this.waiters.push(waiter)
          const timer = setTimeout(() => {
            this.waiters = this.waiters.filter((candidate) => candidate !== waiter)
            waiter.reject(new ContractError('timeout', 'no event received'))
          }, timeoutMs)
          try {
            return await waiter.promise
          } finally {
            clearTimeout(timer)
          }
        },
        async replay({ afterSequence: cursor }) {
          return state.events.filter((event) => event.sequence > cursor)
        },
        async disconnect() {
          this.connected = false
          for (const waiter of this.waiters.splice(0)) {
            waiter.reject(new ContractError('disconnected', 'client is disconnected'))
          }
          clients.delete(this)
        },
      }
      clients.add(client)
      return client
    },

    async registerRuntime({ user, deviceId, harness, provider, model, localSessionId }) {
      const runtime = {
        id: randomUUID(),
        user,
        activeRequestId: null,
        provenance: {
          userId: user.id,
          deviceId,
          harness,
          provider,
          model,
          localSessionId,
          captureFidelity: 'harness_transcript',
        },
      }
      runtimes.set(runtime.id, runtime)
      return runtime
    },

    async claimRequest({ runtime, requestId }) {
      const registered = runtimes.get(runtime.id)
      if (!registered) throw new ContractError('forbidden', 'runtime is not registered')
      let found
      let containingSession
      for (const session of sessions.values()) {
        found = session.events.find((event) => event.id === requestId && event.type === 'agent_request')
        if (found) {
          containingSession = session
          break
        }
      }
      if (!found) throw new ContractError('not_found', 'agent request not found')
      if (containingSession.completedRequestIds.has(requestId)) {
        throw new ContractError('already_completed', 'agent request was completed before publication')
      }
      if (found.actor.userId !== registered.user.id) {
        throw new ContractError('claim_not_owned', 'request belongs to another user')
      }
      if (registered.activeRequestId && registered.activeRequestId !== requestId) {
        throw new ContractError('runtime_busy', 'runtime already has an active turn')
      }
      registered.activeRequestId = requestId
      return {
        request: found,
        canonicalHistory: containingSession.events.filter((event) => event.sequence <= found.sequence),
      }
    },

    async completeClaim({ runtime, requestId, content, idempotencyKey }) {
      const registered = runtimes.get(runtime.id)
      if (!registered || registered.activeRequestId !== requestId) {
        throw new ContractError('claim_not_owned', 'runtime does not hold this claim')
      }
      let request
      let session
      for (const candidate of sessions.values()) {
        request = candidate.events.find((event) => event.id === requestId)
        if (request) {
          session = candidate
          break
        }
      }
      const event = appendCommitted({
        session,
        user: registered.user,
        type: 'agent_response',
        payload: { content },
        idempotencyKey,
        replyTo: requestId,
        runtime: registered,
      })
      registered.activeRequestId = null
      session.completedRequestIds.add(requestId)
      return event
    },

    async commitLocalTurn({ session, runtime, localTurnId, basedOnSequence, request, response }) {
      const state = getSession(session.id)
      const registered = runtimes.get(runtime.id)
      if (!registered) throw new ContractError('forbidden', 'runtime is not registered')
      if (typeof localTurnId !== 'string' || !localTurnId || localTurnId.length > 128) {
        throw new ContractError('invalid_input', 'localTurnId is invalid')
      }
      if (!Number.isSafeInteger(basedOnSequence) || basedOnSequence < 0) {
        throw new ContractError('invalid_input', 'basedOnSequence is invalid')
      }
      const sanitizedRequest = redact(structuredClone(request ?? {}))
      const sanitizedResponse = redact(structuredClone(response ?? {}))
      const operationKey = `${registered.id}\0${localTurnId}`
      const existing = state.localTurns.get(operationKey)
      if (existing) {
        const sameOperation = existing.basedOnSequence === basedOnSequence
          && JSON.stringify(existing.requestEvent.payload) === JSON.stringify(sanitizedRequest)
          && JSON.stringify(existing.responseEvent.payload) === JSON.stringify(sanitizedResponse)
        if (!sameOperation) {
          throw new ContractError('idempotency_conflict', 'local turn id was reused for different content')
        }
        return existing
      }

      const headBeforeCommit = state.events.length
      if (basedOnSequence > headBeforeCommit) {
        throw new ContractError('invalid_input', 'basedOnSequence is ahead of canonical history')
      }
      const requestEvent = appendCommitted({
        session: state,
        user: registered.user,
        type: 'agent_request',
        payload: sanitizedRequest,
        idempotencyKey: `local-turn:${registered.id}:${localTurnId}:request`,
        runtime: registered,
      })
      const responseEvent = appendCommitted({
        session: state,
        user: registered.user,
        type: 'agent_response',
        payload: sanitizedResponse,
        idempotencyKey: `local-turn:${registered.id}:${localTurnId}:response`,
        replyTo: requestEvent.id,
        runtime: registered,
      })
      state.completedRequestIds.add(requestEvent.id)
      const committed = Object.freeze({
        headBeforeCommit,
        reconciliationRequired: headBeforeCommit > basedOnSequence,
        basedOnSequence,
        requestEvent,
        responseEvent,
      })
      state.localTurns.set(operationKey, committed)
      return committed
    },

    async listEvents({ session, afterSequence = 0 }) {
      return getSession(session.id).events.filter((event) => event.sequence > afterSequence)
    },

    async close() {
      for (const client of [...clients]) await client.disconnect()
      sessions.clear()
      runtimes.clear()
    },
  }
}
