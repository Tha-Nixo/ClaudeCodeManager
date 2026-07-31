import { createRoot } from 'react-dom/client'
import App from './App'
import './theme/claude-dark.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root non trovato in index.html')

// Niente <StrictMode>: in sviluppo rimonta gli effetti due volte, e qui un
// effetto fa nascere un processo reale (PowerShell + Claude). Il doppio giro
// lascerebbe un processo spawnato e ucciso ad ogni avvio, più due record
// in ~/.claude/sessions/. Il costo supera il beneficio in un'app che possiede
// processi del sistema operativo.
createRoot(container).render(<App />)
