import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function readKey(): string {
  try {
    const env = readFileSync(resolve(here, '../.env'), 'utf8')
    return env.match(/^REMOTE_KEY=(.*)$/m)?.[1].trim() ?? ''
  } catch {
    return ''
  }
}

const KEY = readKey()
// Unlike Work Hub/Glass Console/Sensorscope, this backend only works when it
// runs ON the phone — adb-to-self has nothing to talk to from the Mac. So
// the dev-loop proxy target is the phone's LAN IP, not localhost.
const BACKEND = process.env.REMOTE_BACKEND || 'http://192.168.1.128:8790'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (KEY) proxyReq.setHeader('x-remote-key', KEY)
          })
        },
      },
    },
  },
  build: { target: 'esnext' },
})
