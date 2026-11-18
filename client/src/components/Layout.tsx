import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, Dumbbell, Calculator, Wallet, Palette, Settings, MessageSquare, LineChart, Video } from 'lucide-react'
import { cn } from '../lib/utils'
import ThemeToggle from './ThemeToggle'
import UpdateNotice from './UpdateNotice'
import BrandMark from './BrandMark'
import QuickSearch from './QuickSearch'
import { useDiscordInboxCounts } from '../hooks/useDiscordInboxCounts'
import { useDiscordConfigured } from '../hooks/useDiscordConfigured'
import { useRecorder } from './recorder/RecorderProvider'
import { useBackupMirrorAlert } from '../hooks/useBackupMirrorAlert'

interface NavItem {
  to: string
  label: string
  icon: typeof Users
  discordOnly?: boolean
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Coaching',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/athletes', label: 'Athletes', icon: Users },
      { to: '/programs', label: 'Programs', icon: Dumbbell },
      // Deliberately NOT discordOnly: bar-path analysis works on any video file, so
      // gating it behind the Discord integration would hide a standalone tool
      // behind an unrelated setup step.
      { to: '/analysis', label: 'Bar path', icon: LineChart },
      { to: '/discord-inbox', label: 'Inbox', icon: MessageSquare, discordOnly: true },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/calculators', label: 'Calculators', icon: Calculator },
      { to: '/styles', label: 'Excel Styles', icon: Palette },
      { to: '/payments', label: 'Payments', icon: Wallet },
    ],
  },
]

const settingsItem: NavItem = { to: '/settings', label: 'Settings', icon: Settings }

const itemClass =
  'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 ease-smooth hover:bg-foreground/[0.05] hover:text-foreground'

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const inboxCounts = useDiscordInboxCounts()
  const { configured: discordConfigured } = useDiscordConfigured()
  const { startRecording, isRecording } = useRecorder()
  const inboxBadge = inboxCounts.unmatched + inboxCounts.unreviewed + inboxCounts.unreadMessages
  useBackupMirrorAlert()

  /**
   * Whether a nav entry owns the current screen.
   *
   * Prefix match, not equality: an exact comparison lit nothing at all on
   * /athletes/:id or /programs/:id, so the sidebar went blank the moment a coach
   * opened anything — which is most of the time they spend in the app. Root is
   * the exception, since every path starts with "/".
   */
  const isActive = (to: string): boolean =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)

  const renderItem = ({ to, label, icon: Icon }: NavItem) => {
    const badge = to === '/discord-inbox' && inboxBadge > 0 ? inboxBadge : null
    const active = isActive(to)
    return (
      <Link
        key={to}
        to={to}
        aria-current={active ? 'page' : undefined}
        className={cn(itemClass, 'shrink-0', active && 'bg-primary/10 text-foreground hover:bg-primary/15')}
      >
        {/* Accent rail on the active entry. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-1.5 left-0 hidden w-[2px] rounded-full bg-primary transition-opacity md:block',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
        <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
        <span className="hidden md:inline">{label}</span>
        {badge !== null && (
          <span className="num ml-auto hidden min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground md:inline-flex">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </Link>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background md:flex-row">
      <nav className="flex w-full shrink-0 border-b bg-sidebar bg-glow-side md:h-screen md:w-60 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
        <Link to="/" className="hidden items-center gap-2.5 px-5 pb-5 pt-5 md:flex" aria-label="CoachBoard home">
          <BrandMark className="h-[18px] w-auto" />
          <span className="text-[15px] font-semibold tracking-tight">CoachBoard</span>
        </Link>

        <div className="flex flex-1 gap-0.5 overflow-x-auto px-2 py-1.5 md:flex-col md:gap-5 md:overflow-visible md:px-3 md:py-0">
          {navGroups.map((group) => (
            <div key={group.label} className="contents md:flex md:flex-col md:gap-0.5">
              <div className="hidden px-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 md:block">
                {group.label}
              </div>
              {group.items.filter((n) => !n.discordOnly || discordConfigured).map(renderItem)}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-0.5 px-2 py-1.5 md:flex-col md:items-stretch md:gap-0.5 md:border-t md:px-3 md:py-3">
          {/* An action, not a route: recording follows the coach across pages, so
              it deliberately does not navigate anywhere. */}
          <button
            onClick={startRecording}
            disabled={isRecording}
            className={cn(itemClass, 'disabled:opacity-60')}
            title="Record your screen with voice-over"
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <Video className="h-4 w-4" />
              {isRecording && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-destructive" />}
            </span>
            <span className="hidden md:inline">{isRecording ? 'Recording…' : 'Record'}</span>
          </button>
          {renderItem(settingsItem)}
          <div className="hidden pt-2 md:block">
            <ThemeToggle />
          </div>
        </div>
      </nav>
      <main className="h-full min-w-0 flex-1 overflow-auto bg-glow-main p-6 md:px-10 md:py-8">{children}</main>
      <UpdateNotice />
      <QuickSearch />
    </div>
  )
}
