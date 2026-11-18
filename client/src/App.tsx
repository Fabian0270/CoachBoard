import { lazy, Suspense } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './components/ui/toast'
import { ConfirmProvider } from './components/ui/confirm-dialog'
import RecorderProvider from './components/recorder/RecorderProvider'
import Dashboard from './pages/Dashboard'
import AthletesList from './pages/AthletesList'
import AthleteDetail from './pages/AthleteDetail'
import NewAthlete from './pages/NewAthlete'
import NewProgram from './pages/NewProgram'
import ProgramDetail from './pages/ProgramDetail'
import ProgramReport from './pages/ProgramReport'
import ProgramComparison from './pages/ProgramComparison'
import Calculators from './pages/Calculators'
import Payments from './pages/Payments'
import ExportStyles from './pages/ExportStyles'
import Settings from './pages/Settings'
import DiscordInbox from './pages/DiscordInbox'
// The bar path pages carry the tracker, the pose model's loader and their
// charts; most visits to the app never open them, so they load when first
// opened instead of with everything else at start (N5).
const VideoAnalysis = lazy(() => import('./pages/VideoAnalysis'))
const SavedAnalysis = lazy(() => import('./pages/SavedAnalysis'))
const CompareAnalyses = lazy(() => import('./pages/CompareAnalyses'))

const RouteLoading = () => <p className="text-sm text-muted-foreground">Loading…</p>

export default function App() {
  return (
    <HashRouter>
      <ErrorBoundary>
        <ToastProvider>
        <ConfirmProvider>
        {/* Above <Routes> deliberately: the coach records while clicking
            through the app, so a recorder owned by a route would unmount
            mid-take. See RecorderProvider. */}
        <RecorderProvider>
        <Layout>
          <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/athletes" element={<AthletesList />} />
            <Route path="/athletes/new" element={<NewAthlete />} />
            <Route path="/athletes/:id" element={<AthleteDetail />} />
            <Route path="/programs" element={<ProgramComparison />} />
            <Route path="/programs/new" element={<NewProgram />} />
            <Route path="/programs/:id" element={<ProgramDetail />} />
            <Route path="/programs/:id/report" element={<ProgramReport />} />
            <Route path="/calculators" element={<Calculators />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/styles" element={<ExportStyles />} />
            <Route path="/discord-inbox" element={<DiscordInbox />} />
            <Route path="/analysis" element={<VideoAnalysis />} />
            {/* Before /analysis/:mediaId, or the param would swallow it. */}
            <Route path="/analysis/compare" element={<CompareAnalyses />} />
            <Route path="/analysis/saved/:id" element={<SavedAnalysis />} />
            <Route path="/analysis/:mediaId" element={<VideoAnalysis />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          </Suspense>
        </Layout>
        </RecorderProvider>
        </ConfirmProvider>
        </ToastProvider>
      </ErrorBoundary>
    </HashRouter>
  )
}