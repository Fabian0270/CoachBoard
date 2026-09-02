import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import path from 'path'
import { configureSecureStore } from './secureStore.js'
import {
  canReveal,
  configureSystem,
  dataDir,
  databasePath,
  logFilePath,
  reveal,
} from './systemService.js'

const FAKE_USERDATA = path.join('C:', 'fake', 'coachboard-electron')

function fakeShell() {
  const calls: { openPath: string[]; showItemInFolder: string[] } = {
    openPath: [],
    showItemInFolder: [],
  }
  return {
    calls,
    shell: {
      async openPath(target: string) {
        calls.openPath.push(target)
        return ''
      },
      showItemInFolder(target: string) {
        calls.showItemInFolder.push(target)
      },
    },
  }
}

beforeEach(() => {
  configureSecureStore({ userDataDir: FAKE_USERDATA })
  configureSystem({ shell: null })
})

afterAll(() => {
  configureSecureStore({ userDataDir: null })
  configureSystem({ shell: null })
})

describe('systemService', () => {
  it('derives every path from the injected userData directory', () => {
    expect(dataDir()).toBe(FAKE_USERDATA)
    expect(databasePath()).toBe(path.join(FAKE_USERDATA, 'coachboard.sqlite'))
    expect(logFilePath()).toBe(path.join(FAKE_USERDATA, 'coachboard.log'))
  })

  it('reports that revealing is unavailable outside Electron', async () => {
    expect(canReveal()).toBe(false)
    // The route turns this into a 503 rather than pretending it worked.
    expect(await reveal('data')).toBe(false)
  })

  it('opens the data folder when a shell is injected', async () => {
    const { shell, calls } = fakeShell()
    configureSystem({ shell })

    expect(canReveal()).toBe(true)
    expect(await reveal('data')).toBe(true)
    expect(calls.openPath).toEqual([FAKE_USERDATA])
    expect(calls.showItemInFolder).toEqual([])
  })

  it('highlights the log file rather than just opening the folder', async () => {
    const { shell, calls } = fakeShell()
    configureSystem({ shell })

    expect(await reveal('logs')).toBe(true)
    expect(calls.showItemInFolder).toEqual([path.join(FAKE_USERDATA, 'coachboard.log')])
    expect(calls.openPath).toEqual([])
  })
})
