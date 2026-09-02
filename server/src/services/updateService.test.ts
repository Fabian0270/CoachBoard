import { describe, it, expect, beforeEach } from 'vitest'
import {
  configureUpdates,
  getUpdateState,
  installUpdate,
  resetUpdateStateForTests,
  setUpdateState,
} from './updateService.js'

beforeEach(() => {
  resetUpdateStateForTests()
})

describe('updateService', () => {
  it('starts idle so the UI has something to render before any check runs', () => {
    expect(getUpdateState()).toEqual({ status: 'idle', version: null, message: null })
  })

  it('clears stale fields when the status changes', () => {
    setUpdateState({ status: 'error', message: 'offline' })
    expect(getUpdateState().message).toBe('offline')

    // A later success must not leave the old error message hanging around.
    setUpdateState({ status: 'downloading', version: '1.14.1' })
    expect(getUpdateState()).toEqual({ status: 'downloading', version: '1.14.1', message: null })
  })

  it('refuses to install when nothing is ready', () => {
    let installed = false
    configureUpdates({ install: () => { installed = true } })

    setUpdateState({ status: 'downloading', version: '1.14.1' })
    expect(installUpdate()).toBe(false)
    expect(installed).toBe(false)
  })

  it('installs once an update is downloaded', () => {
    let installed = false
    configureUpdates({ install: () => { installed = true } })

    setUpdateState({ status: 'ready', version: '1.14.1' })
    expect(installUpdate()).toBe(true)
    expect(installed).toBe(true)
  })

  it('refuses to install with no installer wired, rather than pretending', () => {
    // This is the non-Electron case: the route turns it into a 409.
    setUpdateState({ status: 'ready', version: '1.14.1' })
    expect(installUpdate()).toBe(false)
  })
})
