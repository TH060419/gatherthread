import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { loadDriver } from './lib/load-driver.mjs'

describe('persistence redaction contract', () => {
  let driver

  beforeEach(async () => {
    driver = await loadDriver()
  })

  afterEach(async () => {
    await driver.close()
  })

  test('credentials are redacted and private harness context is excluded before persistence', async () => {
    const owner = await driver.createUser('owner')
    const session = await driver.createSession({ owner, mode: 'solo' })
    const client = await driver.connectClient({ session, user: owner })
    const fakeApiKey = ['sk', 'live', '0123456789abcdef'].join('-')
    const fakeBearer = ['Bearer', 'header.payload.signature'].join(' ')

    await client.append({
      type: 'context_snapshot',
      idempotencyKey: 'redaction-1',
      payload: {
        fidelity: 'harness_transcript',
        api_key: fakeApiKey,
        note: `credential=${fakeBearer}`,
        raw_thinking: 'private reasoning must not persist',
        messages: [
          { role: 'system', content: 'private system instruction' },
          { role: 'developer', content: 'private developer instruction' },
          { role: 'user', content: 'share this visible message' },
        ],
      },
    })

    const [persisted] = await driver.listEvents({ session })
    const serialized = JSON.stringify(persisted)
    assert.equal(serialized.includes(fakeApiKey), false)
    assert.equal(serialized.includes(fakeBearer), false)
    assert.equal(serialized.includes('private reasoning must not persist'), false)
    assert.equal(serialized.includes('private system instruction'), false)
    assert.equal(serialized.includes('private developer instruction'), false)
    assert.equal(serialized.includes('share this visible message'), true)
    assert.equal(persisted.payload.fidelity, 'harness_transcript')
  })
})
