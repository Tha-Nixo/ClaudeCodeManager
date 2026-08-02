import { createRoot } from 'react-dom/client'
import App from './App'
import MonitorWindow from './monitor/MonitorWindow'
import './theme/claude-dark.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root non trovato in index.html')

// Le due finestre condividono lo stesso bundle e si distinguono dall'ancora.
// È l'unica parte del percorso che non cambia fra il server di sviluppo e il
// caricamento da file://, quindi funziona identica nei due casi.
const isMonitor = window.location.hash === '#monitor'

// Niente <StrictMode>: in sviluppo rimonta gli effetti due volte, e qui un
// effetto fa nascere un processo reale (PowerShell + Claude). Il doppio giro
// lascerebbe un processo spawnato e ucciso ad ogni avvio, più due record
// in ~/.claude/sessions/. Il costo supera il beneficio in un'app che possiede
// processi del sistema operativo.
createRoot(container).render(isMonitor ? <MonitorWindow /> : <App />)
