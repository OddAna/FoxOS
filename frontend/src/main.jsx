import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

import { AuthProvider } from './contexts/AuthContext.jsx'
import { LocaleProvider } from './contexts/LocaleContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LocaleProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </LocaleProvider>
  </StrictMode>,
)
