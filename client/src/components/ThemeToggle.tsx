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

  return (
    <div className="p-3 md:border-t border-primary-foreground/20 dark:border-[#2b2b2b]">
      <div className="flex gap-1 rounded-md bg-primary-foreground/10 dark:bg-[#2a2d2e] p-1">
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            title={label}
            aria-label={`${label} theme`}
            aria-pressed={theme === value}
            className={cn(
              'flex flex-1 items-center justify-center rounded p-1.5 transition-colors hover:bg-primary-foreground/10 dark:text-[#c8c8c8] dark:hover:bg-[#37373d]',
              theme === value && 'bg-primary-foreground/20 dark:bg-[#37373d] dark:text-white',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </div>
  )
}
