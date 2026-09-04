import { HashRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './components/ui/toast'
import { ConfirmProvider } from './components/ui/confirm-dialog'
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
import VideoAnalysis from './pages/VideoAnalysis'
import SavedAnalysis from './pages/SavedAnalysis'
// Temporary, for the 11c screen-recorder spike. Deliberately not in the sidebar.
import RecorderSpike from './pages/RecorderSpike'

export default function App() {
  return (
    <HashRouter>
      <ErrorBoundary>
        <ToastProvider>
        <ConfirmProvider>
        <Layout>
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
            <Route path="/analysis/saved/:id" element={<SavedAnalysis />} />
            <Route path="/analysis/:mediaId" element={<VideoAnalysis />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/recorder-spike" element={<RecorderSpike />} />
          </Routes>
        </Layout>
        </ConfirmProvider>
        </ToastProvider>
      </ErrorBoundary>
    </HashRouter>
  )
}