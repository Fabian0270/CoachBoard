import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'
import { cn } from '../lib/utils'
import { getStoredTheme, setTheme, type Theme } from '../lib/theme'

const options: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

export default function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>('system')

  useEffect(() => {
    setThemeState(getStoredTheme())
  }, [])

  const choose = (next: Theme) => {
    setTheme(next)
    setThemeState(next)
  }

  const activeIndex = options.findIndex((o) => o.value === theme)

  return (
    <div className="p-3 md:border-t border-primary-foreground/20 dark:border-[#2b2b2b]">
      <div className="relative flex rounded-md bg-primary-foreground/10 dark:bg-[#2a2d2e] p-1">
        {/* Sliding indicator — sits behind the buttons and glides to the
            selected option. Width is one third of the track (minus the p-1
            padding); translateX steps it by its own width per option. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 left-1 rounded bg-primary-foreground/20 dark:bg-[#37373d] shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{
            width: 'calc((100% - 0.5rem) / 3)',
            transform: `translateX(${activeIndex * 100}%)`,
          }}
        />
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            title={label}
            aria-label={`${label} theme`}
            aria-pressed={theme === value}
            className={cn(
              'relative z-10 flex flex-1 items-center justify-center rounded p-1.5 transition-colors hover:text-white/90 dark:text-[#c8c8c8] dark:hover:text-white',
              theme === value && 'dark:text-white',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </div>
  )
}
