import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertDriverShape } from './driver-contract.mjs'

export async function loadDriver() {
  const configured = process.env.COLLAB_E2E_DRIVER
  const moduleUrl = configured
    ? pathToFileURL(resolve(process.cwd(), configured)).href
    : new URL('./memory-driver.mjs', import.meta.url).href
  const driverModule = await import(moduleUrl)

  if (typeof driverModule.createDriver !== 'function') {
    throw new TypeError(`${moduleUrl} must export createDriver()`)
  }

  return assertDriverShape(await driverModule.createDriver())
}
