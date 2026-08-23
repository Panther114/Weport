import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 构建产物直接写入 Fastify 静态目录 ../public（emptyOutDir 清空重建，
// 会替换占位用的 public/index.html）。开发模式 /api 代理到本地 8080 服务。
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
