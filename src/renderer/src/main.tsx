import { createRoot } from 'react-dom/client'
import App from './App'
import MonitorWindow from './monitor/MonitorWindow'
import './theme/claude-dark.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found in index.html')

// Both windows share the same bundle and are distinguished by URL hash.
// This is the only URL component consistent across the dev server and file:// loading.
const isMonitor = window.location.hash === '#monitor'

// No <StrictMode>: in development it remounts effects twice, and here an
// effect spawns a real OS process (PowerShell + Claude). Double-mounting
// would spawn and kill a process on every start, polluting ~/.claude/sessions/.
// The cost outweighs the benefit in an application managing system processes.
createRoot(container).render(isMonitor ? <MonitorWindow /> : <App />)
