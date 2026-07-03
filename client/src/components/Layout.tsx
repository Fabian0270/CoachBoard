import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, Dumbbell, Calculator, Wallet, Palette, Settings, MessageSquare } from 'lucide-react'
import { cn } from '../lib/utils'
import ThemeToggle from './ThemeToggle'
import { useDiscordInboxCounts } from '../hooks/useDiscordInboxCounts'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/athletes', label: 'Athletes', icon: Users },
  { to: '/programs', label: 'Programs', icon: Dumbbell },
  { to: '/calculators', label: 'Calculators', icon: Calculator },
  { to: '/payments', label: 'Payments', icon: Wallet },
  { to: '/styles', label: 'Excel Styles', icon: Palette },
  { to: '/discord-inbox', label: 'Discord Inbox', icon: MessageSquare },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const inboxCounts = useDiscordInboxCounts()
  const inboxBadge = inboxCounts.unmatched + inboxCounts.unreviewed

  return (
    <div className="h-screen overflow-hidden flex flex-col md:flex-row">
      <nav className="bg-primary text-primary-foreground dark:bg-[#181818] dark:text-[#c8c8c8] dark:border-r dark:border-[#2b2b2b] shrink-0 w-full md:w-56 md:h-screen md:overflow-y-auto flex md:flex-col">
        <div className="p-4 font-bold text-xl border-b border-primary-foreground/20 dark:border-[#2b2b2b] dark:text-[#e0e0e0] hidden md:block">CoachBoard</div>
        <div className="flex md:flex-col flex-1 overflow-x-auto md:overflow-visible">
          {navItems.map(({ to, label, icon: Icon }) => {
            const badge = to === '/discord-inbox' && inboxBadge > 0 ? inboxBadge : null
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-primary-foreground/10 dark:border-l-2 dark:border-l-transparent dark:text-[#c8c8c8] dark:hover:bg-[#2a2d2e]',
                  location.pathname === to && 'bg-primary-foreground/20 dark:bg-[#37373d] dark:text-white dark:border-l-blue-500',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden md:inline">{label}</span>
                {badge !== null && (
                  <span className="ml-auto hidden min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white md:inline-flex">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
        <div className="hidden md:block">
          <ThemeToggle />
        </div>
      </nav>
      <main className="flex-1 min-w-0 p-6 overflow-auto h-full">{children}</main>
    </div>
  )
}
