import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import FloatingControls from './components/recorder/FloatingControls'
import './index.css'
import { watchSystemTheme } from './lib/theme'

// Keep the document in sync when the OS theme changes and the preference is "system".
watchSystemTheme()

// The floating recording controls load this same page in their own small
// window (see electron/src/main.ts). They get just the bar — no layout, no
// recorder, no database calls.
const isFloatingControls = window.location.hash.startsWith('#/recorder-controls')
if (isFloatingControls) document.documentElement.classList.add('floating-controls')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isFloatingControls ? <FloatingControls /> : <App />}</React.StrictMode>,
)
