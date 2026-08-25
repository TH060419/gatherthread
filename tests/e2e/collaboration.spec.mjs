import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { loadDriver } from './lib/load-driver.mjs'

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code)
}

describe('collaboration contract', () => {
  let driver

  beforeEach(async () => {
    driver = await loadDriver()
  })

  afterEach(async () => {
    await driver.close()
  })

  test('two authenticated users on two clients see the same ordered multi-session updates', async () => {
    const owner = await driver.createUser('owner')
    const participant = await driver.createUser('participant')
    const session = await driver.createSession({ owner, mode: 'multi' })
    await driver.addMember({ session, actor: owner, user: participant, role: 'participant' })
    const ownerClient = await driver.connectClient({ session, user: owner })
    const participantClient = await driver.connectClient({ session, user: participant })

    await Promise.all([
      ownerClient.append({ type: 'human_chat', payload: { text: 'from owner' }, idempotencyKey: 'owner-1' }),
      participantClient.append({ type: 'human_chat', payload: { text: 'from participant' }, idempotencyKey: 'participant-1' }),
    ])

    const ownerView = [await ownerClient.nextEvent(), await ownerClient.nextEvent()]
    const participantView = [await participantClient.nextEvent(), await participantClient.nextEvent()]
    assert.deepEqual(ownerView.map((event) => event.id), participantView.map((event) => event.id))
    assert.deepEqual(ownerView.map((event) => event.sequence), [1, 2])
    assert.deepEqual(ownerView, await driver.listEvents({ session }))
  })

  test('a solo viewer can follow but cannot persist writes', async () => {
    const owner = await driver.createUser('owner')
    const viewer = await driver.createUser('viewer')
    const session = await driver.createSession({ owner, mode: 'solo' })
    await driver.addMember({ session, actor: owner, user: viewer, role: 'viewer' })
    const ownerClient = await driver.connectClient({ session, user: owner })
    const viewerClient = await driver.connectClient({ session, user: viewer })

    const accepted = await ownerClient.append({
      type: 'human_chat',
      payload: { text: 'visible owner update' },
      idempotencyKey: 'solo-owner-1',
    })
    assert.equal((await viewerClient.nextEvent()).id, accepted.id)

    await rejectsWithCode(
      viewerClient.append({ type: 'human_chat', payload: { text: 'must fail' }, idempotencyKey: 'viewer-write' }),
      'forbidden',
    )
    assert.equal((await driver.listEvents({ session })).length, 1)
  })

  test('an idempotent retry returns the original event without a duplicate', async () => {
    const owner = await driver.createUser('owner')
    const session = await driver.createSession({ owner, mode: 'multi' })
    const client = await driver.connectClient({ session, user: owner })
    const input = { type: 'human_chat', payload: { text: 'retry me' }, idempotencyKey: 'stable-key' }

    const first = await client.append(input)
    const retry = await client.append(input)

    assert.deepEqual(retry, first)
    await rejectsWithCode(
      client.append({ ...input, payload: { text: 'different operation' } }),
      'idempotency_conflict',
    )
    assert.equal((await driver.listEvents({ session })).length, 1)
  })

  test('a disconnected client resumes every missed event from its durable cursor', async () => {
    const owner = await driver.createUser('owner')
    const session = await driver.createSession({ owner, mode: 'multi' })
    const firstClient = await driver.connectClient({ session, user: owner })
    const first = await firstClient.append({ type: 'human_chat', payload: { text: 'one' }, idempotencyKey: 'replay-1' })
    await firstClient.nextEvent()
    await firstClient.disconnect()

    const writer = await driver.connectClient({ session, user: owner, afterSequence: first.sequence })
    await writer.append({ type: 'human_chat', payload: { text: 'two' }, idempotencyKey: 'replay-2' })
    await writer.append({ type: 'human_chat', payload: { text: 'three' }, idempotencyKey: 'replay-3' })

    const resumed = await driver.connectClient({ session, user: owner, afterSequence: first.sequence })
    const replay = await resumed.replay({ afterSequence: first.sequence })
    assert.deepEqual(replay.map((event) => event.sequence), [2, 3])
    assert.deepEqual(replay.map((event) => event.payload.text), ['two', 'three'])
  })

  test('concurrent appends allocate unique contiguous per-session sequences', async () => {
    const owner = await driver.createUser('owner')
    const participant = await driver.createUser('participant')
    const session = await driver.createSession({ owner, mode: 'multi' })
    await driver.addMember({ session, actor: owner, user: participant, role: 'participant' })
    const clients = await Promise.all([
      driver.connectClient({ session, user: owner }),
      driver.connectClient({ session, user: participant }),
    ])

    await Promise.all(Array.from({ length: 24 }, (_, index) => clients[index % 2].append({
      type: 'human_chat',
      payload: { index },
      idempotencyKey: `concurrent-${index}`,
    })))

    const events = await driver.listEvents({ session })
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 24 }, (_, index) => index + 1))
    assert.equal(new Set(events.map((event) => event.id)).size, 24)
  })

  test('agent requests are claimed by the initiating runtime and serialized per runtime', async () => {
    const owner = await driver.createUser('owner')
    const participant = await driver.createUser('participant')
    const session = await driver.createSession({ owner, mode: 'multi' })
    await driver.addMember({ session, actor: owner, user: participant, role: 'participant' })
    const ownerClient = await driver.connectClient({ session, user: owner })
    const participantClient = await driver.connectClient({ session, user: participant })
    const ownerRuntime = await driver.registerRuntime({
      user: owner,
      deviceId: 'owner-device',
      harness: 'codex',
      provider: 'openai',
      model: 'test-model',
      localSessionId: 'local-owner',
    })
    const participantRuntime = await driver.registerRuntime({
      user: participant,
      deviceId: 'participant-device',
      harness: 'claude-code',
      provider: 'anthropic',
      model: 'test-model',
      localSessionId: 'local-participant',
    })

    const chat = await participantClient.append({
      type: 'human_chat',
      payload: { text: 'shared context only' },
      idempotencyKey: 'human-context',
    })
    const firstRequest = await ownerClient.append({
      type: 'agent_request',
      payload: { text: 'owner turn one' },
      idempotencyKey: 'agent-owner-1',
    })
    const secondRequest = await ownerClient.append({
      type: 'agent_request',
      payload: { text: 'owner turn two' },
      idempotencyKey: 'agent-owner-2',
    })

    await rejectsWithCode(
      driver.claimRequest({ runtime: participantRuntime, requestId: firstRequest.id }),
      'claim_not_owned',
    )
    const claim = await driver.claimRequest({ runtime: ownerRuntime, requestId: firstRequest.id })
    assert.deepEqual(claim.canonicalHistory.map((event) => event.id), [chat.id, firstRequest.id])
    await rejectsWithCode(
      driver.claimRequest({ runtime: ownerRuntime, requestId: secondRequest.id }),
      'runtime_busy',
    )

    const response = await driver.completeClaim({
      runtime: ownerRuntime,
      requestId: firstRequest.id,
      content: 'completed locally',
      idempotencyKey: 'agent-response-1',
    })
    assert.equal(response.replyTo, firstRequest.id)
    assert.equal(response.runtime.userId, owner.id)
    assert.equal(response.runtime.deviceId, 'owner-device')
    assert.equal(response.runtime.captureFidelity, 'harness_transcript')

    const secondClaim = await driver.claimRequest({ runtime: ownerRuntime, requestId: secondRequest.id })
    assert.equal(secondClaim.request.id, secondRequest.id)
  })
})
