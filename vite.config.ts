import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Dev-only helper: the recorder page POSTs finished videos here so they land in public/exports.
const saveExports = (): Plugin => ({
  name: 'save-exports',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      const name = String(req.url ?? '').replace(/^\//, '').split('?')[0]
      if (req.method !== 'POST' || !/^[\w.-]+$/.test(name)) {
        res.statusCode = 400
        res.end('bad request')
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        mkdirSync('public/exports', { recursive: true })
        writeFileSync(resolve('public/exports', name), Buffer.concat(chunks))
        res.end('ok')
      })
    })
  },
})

// `three` and `three/examples/...` must resolve to a single copy or Three warns about duplicate instances.
export default defineConfig({
  plugins: [saveExports()],
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three', 'three/examples/jsm/postprocessing/Pass.js'] },
})
