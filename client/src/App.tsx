import { HashRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import AthletesList from './pages/AthletesList'
import AthleteDetail from './pages/AthleteDetail'
import NewAthlete from './pages/NewAthlete'
import NewProgram from './pages/NewProgram'
import ProgramDetail from './pages/ProgramDetail'
import ProgramReport from './pages/ProgramReport'
import ProgramComparison from './pages/ProgramComparison'
import ProgressTracking from './pages/ProgressTracking'

export default function App() {
  return (
    <HashRouter>
      <ErrorBoundary>
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
            <Route path="/progress" element={<ProgressTracking />} />
          </Routes>
        </Layout>
      </ErrorBoundary>
    </HashRouter>
  )
}