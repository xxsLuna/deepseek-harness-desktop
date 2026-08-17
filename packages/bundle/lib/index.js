// @ts-check
/**
 * @dsh-desktop/bundle — the desktop surface's runtime glue plugin. Mirrors the
 * upstream `dsh-web-app` glue for a windowed surface with no URL: mounts the
 * `frontend-static` fallback owner over the built web dist, registers exact
 * SSE routes for the two event streams (the renderer cannot open a WebSocket
 * to the app scheme, so the streams ride the fetch downlink the API gateway
 * already serves), and contributes the desktop-surface prompt section plus the
 * DSH_SURFACE shell variable.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'

/** Stable Cordis plugin name. */
export const name = 'desktop-runtime'

export const inject = ['webServer']

/** @typedef {{ surfaceContext: boolean }} Config */
export const Config = z.object({
  /** Register the desktop-surface prompt section and shell variable. */
  surfaceContext: z.boolean().default(true),
})

/** The staged harness root (the directory holding node_modules). */
const HARNESS_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Resolve the built web dist through the frontend package exports. */
function resolveDistIndex() {
  const require = createRequire(import.meta.url)
  return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
}

/** Prompt text telling the model which surface the user is on. */
function desktopSurfacePrompt() {
  return [
    'The user interacts with you through the DeepSeek Harness desktop application (a windowed app, not a browser tab).',
    'There is no URL for this UI and no HTTP server serving it; "this window" or "this app" means the desktop window.',
    'The app provides no implicit DOM, route, or screenshot context.',
    'Starting a web server does not show the user anything unless they open a browser themselves.',
    'Code changes to the harness take effect only after the application restarts; a page refresh is not available.',
  ].join(' ')
}

/**
 * Pipe one web Response into a node ServerResponse, streaming the body.
 * @param {Response} response - the gateway's response.
 * @param {import('node:http').ServerResponse} res - the carrier response.
 */
async function pipeResponse(response, res) {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body === null) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve))
  }
  res.end()
}

/**
 * Mount the desktop surface glue.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Config} config - surface options.
 */
export function apply(ctx, config) {
  ctx.plugin(FrontendStatic, { distIndex: resolveDistIndex() })

  // SSE downlink: exact routes beat the /api prefix route, so these two paths
  // reach the gateway's fetch handler (which streams SSE) instead of the web
  // carrier's WebSocket-upgrade answer.
  ctx.inject(['apiProxy'], (proxyCtx) => {
    const handler = toFetchHandler(proxyCtx.apiProxy)
    for (const path of ['/api/events.mux', '/api/events.host']) {
      proxyCtx.effect(() => proxyCtx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          const control = new AbortController()
          res.once('close', () => control.abort())
          const response = await handler.fetch(new Request(`http://127.0.0.1${req.url ?? path}`, {
            method: req.method,
            headers: { accept: 'text/event-stream' },
            signal: control.signal,
          }))
          await pipeResponse(response, res)
        },
      }), `desktop-runtime: SSE route ${path}`)
    }
  })

  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, HARNESS_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:desktop-surface',
        order: -98,
        text: desktopSurfacePrompt,
      })
    })
    ctx.inject(['shellEnv'], (envCtx) => {
      envCtx.shellEnv.register({
        name: 'desktop-runtime',
        variables: { DSH_SURFACE: { description: 'UI surface serving this session: the DeepSeek Harness desktop application.' } },
        resolve: () => ({ DSH_SURFACE: 'desktop' }),
      })
    })
  }
}
