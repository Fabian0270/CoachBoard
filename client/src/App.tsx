import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import AthletesList from './pages/AthletesList'
import AthleteDetail from './pages/AthleteDetail'
import NewAthlete from './pages/NewAthlete'
import NewProgram from './pages/NewProgram'
import ProgramDetail from './pages/ProgramDetail'
import ProgramComparison from './pages/ProgramComparison'
import ProgressTracking from './pages/ProgressTracking'
import UploadPrograms from './pages/UploadPrograms'

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/athletes" element={<AthletesList />} />
          <Route path="/athletes/new" element={<NewAthlete />} />
          <Route path="/athletes/:id" element={<AthleteDetail />} />
          <Route path="/programs" element={<ProgramComparison />} />
          <Route path="/programs/new" element={<NewProgram />} />
          <Route path="/programs/:id" element={<ProgramDetail />} />
          <Route path="/progress" element={<ProgressTracking />} />
          <Route path="/upload" element={<UploadPrograms />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
