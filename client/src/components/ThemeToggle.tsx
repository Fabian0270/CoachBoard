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
    <div>
      <div className="relative flex rounded-md border bg-background/60 p-0.5">
        {/* Sliding indicator — sits behind the buttons and glides to the
            selected option. Width is one third of the track (minus the p-1
            padding); translateX steps it by its own width per option. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-[5px] bg-card shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_hsl(0_0%_0%/0.1)] transition-transform duration-300 ease-smooth motion-reduce:transition-none"
          style={{
            width: 'calc((100% - 0.25rem) / 3)',
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
              'relative z-10 flex flex-1 items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground',
              theme === value && 'text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </div>
  )
}
