import { Routes, Route } from 'react-router'
import { AppDataProvider } from '@/lib/data/store'
import { Layout } from '@/components/Layout'
import Overview from '@/pages/Overview'
import Markets from '@/pages/Markets'
import Portfolio from '@/pages/Portfolio'
import Agent from '@/pages/Agent'
import Autopilot from '@/pages/Autopilot'
import Fx from '@/pages/Fx'
import Settings from '@/pages/Settings'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'

/**
 * Routing (pattern B — nested routes + <Outlet/>, vedi react-dev.md).
 * Per GitHub Pages: base './' in vite.config.ts + public/404.html con
 * SPA redirect che preserva la route.
 */
export default function App() {
  return (
    <AppDataProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="mercati" element={<Markets />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="agent" element={<Agent />} />
          <Route path="autopilot" element={<PageErrorBoundary pageName="Autopilot"><Autopilot /></PageErrorBoundary>} />
          <Route path="fx" element={<Fx />} />
          <Route path="impostazioni" element={<Settings />} />
        </Route>
      </Routes>
    </AppDataProvider>
  )
}
