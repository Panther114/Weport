import './preload-env'
import { app } from 'electron'
import { main as runCli } from './cli'

// Headless extractor entry: no BrowserWindow / no renderer UI.
// Electron is only used as a runtime for native modules + app paths.

// Keep process alive for CLI work even when there are zero windows.
app.on('window-all-closed', () => {
  // intentionally empty — CLI calls process.exit
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    // electron . <cmd>        → argv: [electron, ., cmd, ...]
    // packaged app.exe <cmd>  → argv: [app, cmd, ...]
    const argv = process.argv.slice(app.isPackaged ? 1 : 2)
    await runCli(argv.length > 0 ? argv : ['help'])
  })
}
