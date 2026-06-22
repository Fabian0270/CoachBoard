import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { watchSystemTheme } from './lib/theme'

// Keep the document in sync when the OS theme changes and the preference is "system".
watchSystemTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
