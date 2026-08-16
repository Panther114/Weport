import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'

const handleElectronOnStart = (options: { reload: () => void }) => {
  options.reload()
}

// 渲染层 CSP：生产严格、开发兼容 HMR/React Refresh。
// 必须在 meta 中注入（不能仅靠 session.headers，否则 file:// 下不生效）。
const cspPlugin = (mode: string): Plugin => {
  const prod = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: http: data: blob: weport-media:",
    "media-src 'self' https: http: data: blob: weport-media:",
    "font-src 'self' data:",
    "connect-src 'self' https: http: weport-media:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join('; ')
  const dev = prod
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace('connect-src', "connect-src ws: wss:")
  return {
    name: 'inject-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const csp = mode === 'development' ? dev : prod
        return html.replace(
          '<meta name="viewport"',
          `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="viewport"`
        )
      }
    }
  }
}

export default defineConfig(({ mode }) => ({
  base: './',
  server: {
    port: 3000,
    strictPort: false
  },
  build: {
    chunkSizeWarningLimit: 900,
    commonjsOptions: {
      ignoreDynamicRequires: true
    },
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        // 通知弹窗独立入口：只打包 NotificationWindow 依赖，渲染进程内存更低
        popup: resolve(import.meta.dirname, 'popup.html')
      }
    }
  },
  plugins: [
    cspPlugin(mode),
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
      },
      {
        entry: 'electron/annualReportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: {
                entryFileNames: 'annualReportWorker.js',
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
      '@': resolve(import.meta.dirname, 'src')
    }
  }
}))

