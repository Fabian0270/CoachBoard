// ---------------------------------------------------------------------------
// Minimised windows, for the recorder (Windows only).
//
// Electron's desktopCapturer leaves minimised windows out of its list, and
// Windows cannot capture one anyway — a minimised window is not drawn. So the
// picker used to offer only what happened to be open on screen. This lists the
// minimised top-level windows too, under the same id Electron uses once a
// window is visible ("window:<HWND>:0"), and restores the one the coach picks
// just before recording, after which Electron lists and captures it normally.
//
// Talks to user32/dwmapi through koffi (prebuilt Node-API binary per platform,
// nothing compiled). Loaded lazily and only on Windows: if anything here fails,
// the recorder simply falls back to Electron's own list.
// ---------------------------------------------------------------------------

export interface MinimizedWindow {
  /** Same format as desktopCapturer's window ids: "window:<HWND>:0". */
  id: string
  name: string
}

export interface WindowTools {
  listMinimized(): MinimizedWindow[]
  /** Restores a window by its source id. False when it is not a window id or it no longer exists. */
  restore(id: string): boolean
}

const GW_OWNER = 4
const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x80
const DWMWA_CLOAKED = 14
const SW_RESTORE = 9

export function createWindowTools(log: (msg: string) => void): WindowTools | null {
  if (process.platform !== 'win32') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')

    const HWND = koffi.pointer('HWND', koffi.opaque())
    const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)')
    const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)')
    const IsWindow = user32.func('bool __stdcall IsWindow(HWND hwnd)')
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(HWND hwnd)')
    const IsIconic = user32.func('bool __stdcall IsIconic(HWND hwnd)')
    const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(HWND hwnd)')
    const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *buf, int max)')
    const GetWindow = user32.func('HWND __stdcall GetWindow(HWND hwnd, uint32_t cmd)')
    const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hwnd, int index)')
    const ShowWindow = user32.func('bool __stdcall ShowWindow(HWND hwnd, int cmd)')
    const DwmGetWindowAttribute = dwmapi.func(
      'long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ int *value, uint32_t size)',
    )

    /** The same filtering a taskbar applies: real, titled, top-level app windows. */
    const isAppWindow = (hwnd: unknown): boolean => {
      if (!IsWindowVisible(hwnd)) return false
      if (GetWindow(hwnd, GW_OWNER)) return false
      if (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return false
      const cloaked = [0]
      DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4)
      return !cloaked[0]
    }

    const titleOf = (hwnd: unknown): string => {
      const len = GetWindowTextLengthW(hwnd) as number
      if (len <= 0) return ''
      const buf = new Uint16Array(len + 1)
      GetWindowTextW(hwnd, buf, len + 1)
      return String.fromCharCode(...buf.subarray(0, len)).trim()
    }

    const handleOf = (id: string): bigint | null => {
      const m = /^window:(\d+):\d+$/.exec(id)
      return m ? BigInt(m[1]) : null
    }

    return {
      listMinimized() {
        const found: MinimizedWindow[] = []
        const cb = koffi.register((hwnd: unknown) => {
          try {
            if (IsIconic(hwnd) && isAppWindow(hwnd)) {
              const name = titleOf(hwnd)
              if (name) found.push({ id: `window:${koffi.address(hwnd)}:0`, name })
            }
          } catch {
            /* one odd window must not end the walk */
          }
          return true
        }, koffi.pointer(EnumWindowsProc))
        try {
          EnumWindows(cb, 0)
        } finally {
          koffi.unregister(cb)
        }
        return found
      },
      restore(id) {
        const handle = handleOf(id)
        if (handle === null) return false
        const hwnd = koffi.as(handle, HWND)
        if (!IsWindow(hwnd)) return false
        ShowWindow(hwnd, SW_RESTORE)
        return true
      },
    }
  } catch (err) {
    log(`Minimised-window listing unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
