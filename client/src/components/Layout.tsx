import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, Dumbbell, TrendingUp, Wallet } from 'lucide-react'
import { cn } from '../lib/utils'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/athletes', label: 'Athletes', icon: Users },
  { to: '/programs', label: 'Programs', icon: Dumbbell },
  { to: '/progress', label: 'Progress', icon: TrendingUp },
  { to: '/payments', label: 'Payments', icon: Wallet },
]

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <nav className="bg-primary text-primary-foreground w-full md:w-56 md:min-h-screen flex md:flex-col">
        <div className="p-4 font-bold text-xl border-b border-primary-foreground/20 hidden md:block">CoachBoard</div>
        <div className="flex md:flex-col flex-1 overflow-x-auto md:overflow-visible">
          {navItems.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                'flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-primary-foreground/10',
                location.pathname === to && 'bg-primary-foreground/20',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden md:inline">{label}</span>
            </Link>
          ))}
        </div>
      </nav>
      <main className="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  )
}
