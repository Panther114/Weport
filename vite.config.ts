import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'

const handleElectronOnStart = (options: { reload: () => void }) => {
  options.reload()
}

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    strictPort: false
  },
  build: {
    chunkSizeWarningLimit: 900,
    commonjsOptions: {
      ignoreDynamicRequires: true
    }
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'exceljs',
                '@vscode/sudo-prompt',
                'silk-wasm',
                // 原生 .node 二进制不可打包，运行时从 asarUnpack 目录解析
                '@hicccc77/electron-liquid-glass'
              ]
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      },
      {
        entry: 'electron/wcdbHost.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3', 'koffi', 'fsevents', 'electron'],
              output: {
                entryFileNames: 'wcdbHost.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/imageDecryptWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'imageDecryptWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      }
    ])
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})
