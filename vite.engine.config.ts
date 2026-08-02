import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'

const exportWorkerElectronShimPlugin = () => {
  const virtualId = 'virtual:weport-export-worker-electron'
  const resolvedVirtualId = `\0${virtualId}`

  return {
    name: 'weport-export-worker-electron-shim',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === virtualId) return resolvedVirtualId
      return null
    },
    load(id: string) {
      if (id !== resolvedVirtualId) return null
      return `
        import { homedir, tmpdir } from 'os'
        import { join } from 'path'

        const workerUserDataPath = () => String(process.env.WEPORT_USER_DATA_PATH || process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
        const appDataPath = () => {
          if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA
          if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
          return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
        }
        const getPath = (name) => {
          if (name === 'userData') return workerUserDataPath() || join(appDataPath(), 'Weport')
          if (name === 'documents') return join(homedir(), 'Documents')
          if (name === 'desktop') return join(homedir(), 'Desktop')
          if (name === 'downloads') return join(homedir(), 'Downloads')
          if (name === 'temp') return tmpdir()
          if (name === 'appData') return appDataPath()
          return process.cwd()
        }

        export const app = {
          isPackaged: Boolean(process.resourcesPath && process.env.NODE_ENV !== 'development'),
          getPath,
          getAppPath: () => process.cwd(),
          getName: () => 'Weport',
          getVersion: () => process.env.npm_package_version || '0.0.1',
          on: () => app,
          once: () => app,
          off: () => app,
          removeListener: () => app,
          removeAllListeners: () => app
        }
        export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null }
        export const dialog = { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) }
        export const shell = { openExternal: async () => false, showItemInFolder: () => {} }
        export const ipcMain = { on: () => {}, handle: () => {}, removeHandler: () => {} }
        export const ipcRenderer = { sendSync: () => ({}) }
        export const safeStorage = {
          isEncryptionAvailable: () => false,
          encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
          decryptString: (value) => Buffer.isBuffer(value) ? value.toString('utf8') : Buffer.from(value).toString('utf8')
        }
        export const Notification = class {
          static isSupported() { return false }
          on() { return this }
          show() {}
          close() {}
        }
        export default { app, BrowserWindow, dialog, shell, ipcMain, ipcRenderer, safeStorage, Notification }
      `
    },
    transform(code: string, id: string) {
      if (!/\.[cm]?[jt]s$/.test(id)) return null
      if (!code.includes("'electron'") && !code.includes('"electron"')) return null
      const next = code
        .replace(/from\s+(['"])electron\1/g, `from '${virtualId}'`)
        .replace(/import\s*\(\s*(['"])electron\1\s*\)/g, `import('${virtualId}')`)
        .replace(/require\s*\(\s*(['"])electron\1\s*\)/g, `require('${virtualId}')`)
      return next === code ? null : { code: next, map: null }
    }
  }
}

const commonExternals = [
  'better-sqlite3',
  'koffi',
  'fsevents',
  'exceljs',
  'silk-wasm',
  'ffmpeg-static',
  'sherpa-onnx-node',
  '@vscode/sudo-prompt',
  'electron'
]

// Pure build config for the headless WeChat extraction engine (Electron runtime).
// No onstart hook — engine is launched by Weport CLI / Tauri sidecar.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'scripts/empty-renderer.html')
    }
  },
  plugins: [
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: commonExternals
            }
          }
        }
      },
      {
        entry: 'electron/imageDecryptWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: commonExternals,
              output: {
                entryFileNames: 'imageDecryptWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/wcdbWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: commonExternals,
              output: {
                entryFileNames: 'wcdbWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/exportWorker.ts',
        vite: {
          plugins: [exportWorkerElectronShimPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: commonExternals,
              output: {
                entryFileNames: 'exportWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/transcribeWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: commonExternals,
              output: {
                entryFileNames: 'transcribeWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      }
    ])
  ]
})
