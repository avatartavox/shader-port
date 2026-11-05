// Offline recorder: renders the scene frame by frame at fixed timestamps (no requestAnimationFrame,
// so it does not depend on the tab being visible) and encodes H.264 MP4s with WebCodecs + mp4-muxer.
//
// Scene = rings fill (Figma module, WebGPU) + title with Broadcast -> Bloom (Figma modules, WebGPU).
// Two outputs: the scene as is, and the same scene run through the Figma Dither module.
//
// Use with ?scale=1 so the canvases are the real 1920x1080 frame.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { createFigmaFxWebGPU } from './a-fx-webgpu'
import { createFigmaWebGPU } from './a-webgpu-figma'
import { createDitherA } from './dither/a-webgpu'
import { DEFAULT_PARAMS, type DitherParams } from './dither/shared'
import { FILL_SIZE, FRAME, FX_SIZE, RENDER_SCALE, TEXT_BOX, fontLoaded, rasterizeTitle } from './fx-shared'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `<pre id="log" style="padding:16px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap">Cargando…</pre>`
const logEl = document.querySelector<HTMLPreElement>('#log')!
const log = (m: string) => {
  logEl.textContent += `\n${m}`
}

interface Options {
  seconds: number
  fps: number
  bitrate: number
  dither: DitherParams
  /** Base file name, saved as <name>.mp4 and <name>-dither.mp4 in public/exports. */
  name: string
}

async function makeEncoder(width: number, height: number, fps: number, bitrate: number) {
  const codec = 'avc1.64002A' // High profile, level 4.2: fine for 1080p30
  const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps }
  const support = await VideoEncoder.isConfigSupported(config)
  if (!support.supported) throw new Error(`VideoEncoder no soporta ${codec} ${width}x${height} en este navegador`)
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  })
  let error: Error | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      error = e
    },
  })
  encoder.configure(config)
  return {
    async push(canvas: HTMLCanvasElement, index: number) {
      if (error) throw error
      const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / fps), duration: Math.round(1e6 / fps) })
      encoder.encode(frame, { keyFrame: index % fps === 0 })
      frame.close()
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2))
    },
    async finish() {
      await encoder.flush()
      if (error) throw error
      muxer.finalize()
      return new Uint8Array((muxer.target as ArrayBufferTarget).buffer)
    },
  }
}

async function save(name: string, bytes: Uint8Array) {
  const res = await fetch(`/__save/${name}`, { method: 'POST', body: bytes as BlobPart })
  if (!res.ok) throw new Error(`no se pudo guardar ${name}: ${res.status}`)
  return `/exports/${name}`
}

async function record(opts: Partial<Options> = {}) {
  const o: Options = {
    seconds: 6,
    fps: 30,
    bitrate: 14_000_000,
    dither: { ...DEFAULT_PARAMS, algorithm: 'Bayer 8x8', pixelSize: 3, levels: 3 },
    name: 'rings-glitch-bloom',
    ...opts,
  }
  if (RENDER_SCALE !== 1) throw new Error('Abre la página con ?scale=1 para grabar a 1920x1080')
  const W = FRAME.w
  const H = FRAME.h
  const frames = Math.round(o.seconds * o.fps)

  const title = await rasterizeTitle()
  log(`Fuente Afacad Flux: ${fontLoaded() ? 'ok' : 'NO cargada (fallback)'}`)

  const fillCanvas = document.createElement('canvas')
  fillCanvas.width = FILL_SIZE.w
  fillCanvas.height = FILL_SIZE.h
  const fxCanvas = document.createElement('canvas')
  fxCanvas.width = FX_SIZE.w
  fxCanvas.height = FX_SIZE.h
  const fill = await createFigmaWebGPU(fillCanvas)
  const fx = await createFigmaFxWebGPU(fxCanvas, title)
  if (!fill.ok || !fx.ok) throw new Error(`WebGPU: ${fill.ok ? fx.note : fill.note}`)

  const scene = document.createElement('canvas')
  scene.width = W
  scene.height = H
  const sceneCtx = scene.getContext('2d', { alpha: false })!

  const dither = await createDitherA(scene)
  if (!dither.ok) throw new Error(dither.note)
  const dithered = document.createElement('canvas')
  dithered.width = W
  dithered.height = H
  const ditherCtx = dithered.getContext('2d', { alpha: false })!

  const plain = await makeEncoder(W, H, o.fps, o.bitrate)
  const dith = await makeEncoder(W, H, o.fps, o.bitrate)
  await dither.warm?.(o.dither)

  log(`Renderizando ${frames} frames (${o.seconds}s @ ${o.fps}fps, ${W}x${H})…`)
  const t0 = performance.now()
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / o.fps
    // Render and composite in one synchronous stretch: WebGPU canvases are only readable then.
    fill.render(t, 1000 / o.fps, null)
    fx.render(t, 1000 / o.fps, null)
    sceneCtx.drawImage(fillCanvas, 0, 0, W, H)
    sceneCtx.drawImage(fxCanvas, TEXT_BOX.x, TEXT_BOX.y, TEXT_BOX.w, TEXT_BOX.h)
    dither.setInput!(scene)

    await plain.push(scene, i)

    const out = await dither.run(o.dither)
    ditherCtx.putImageData(new ImageData(new Uint8ClampedArray(out.pixels), out.width, out.height), 0, 0)
    await dith.push(dithered, i)

    if (i % 30 === 0) log(`  frame ${i}/${frames}`)
  }
  const renderMs = performance.now() - t0

  const [a, b] = await Promise.all([plain.finish(), dith.finish()])
  const urlA = await save(`${o.name}.mp4`, a)
  const urlB = await save(`${o.name}-dither.mp4`, b)
  log(`Listo en ${(renderMs / 1000).toFixed(1)} s de render`)
  log(`${urlA}  ${(a.byteLength / 1e6).toFixed(2)} MB`)
  log(`${urlB}  ${(b.byteLength / 1e6).toFixed(2)} MB`)
  return { urlA, urlB, bytesA: a.byteLength, bytesB: b.byteLength, renderMs, frames }
}

;(window as unknown as Record<string, unknown>).__record = record
log('Listo. Llama a window.__record({ seconds, fps }) desde la consola.')
