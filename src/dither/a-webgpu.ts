// Option A — the Figma Dither module, unchanged (compute shaders), driven by a small WebGPU runtime.
// Output goes to an offscreen rgba8unorm texture that we read back, so measurements and pixel
// diffs do not depend on canvas presentation timing.
import * as dither from '../figma/dither'
import type { DitherBackend, DitherParams, RunResult } from './shared'

type Source = ImageBitmap | HTMLCanvasElement

export async function createDitherA(image: Source): Promise<DitherBackend> {
  const fail = (note: string): DitherBackend => ({
    id: 'A', ok: false, note, run: async () => { throw new Error(note) }, dispose() {},
  })
  if (!navigator.gpu) return fail('WebGPU no disponible en este navegador')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return fail('No se encontró adaptador WebGPU')

  let device = await adapter.requestDevice()
  let lost: string | null = null
  const watchLost = (d: GPUDevice) => d.lost.then((info) => { if (d === device) lost = `${info.reason}: ${info.message}` })
  watchLost(device)

  const w = image.width
  const h = image.height
  let inputTex: GPUTexture
  let outTex: GPUTexture
  let frame: Record<string, unknown>

  const build = () => {
    inputTex = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: image }, { texture: inputTex, premultipliedAlpha: true }, [w, h])
    outTex = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    })
    frame = { input: inputTex, output: outTex, params: {}, state: {}, time: 0, deltaTime: 16, frame: 0, renderScale: 1 }
    dither.setup(device, frame)
  }
  build()

  const recoverIfLost = async () => {
    if (!lost) return
    device = await adapter.requestDevice()
    lost = null
    watchLost(device)
    build()
  }

  const readback = async (): Promise<Uint8ClampedArray> => {
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture: outTex }, { buffer: buf, bytesPerRow }, [w, h])
    device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const src = new Uint8Array(buf.getMappedRange())
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4)
    buf.unmap()
    buf.destroy()
    return out
  }

  const submit = async (params: DitherParams) => {
    frame.params = params
    frame.frame = (frame.frame as number) + 1
    const t0 = performance.now()
    dither.render(device, frame)
    await device.queue.onSubmittedWorkDone()
    return performance.now() - t0
  }

  return {
    id: 'A',
    ok: true,
    note: 'WebGPU · módulo Figma sin cambios · compute (load + dither + present)',
    /** Replaces the input with a new image/canvas of the same size (used when recording video). */
    setInput(src: Source) {
      device.queue.copyExternalImageToTexture({ source: src }, { texture: inputTex, premultipliedAlpha: true }, [w, h])
    },
    async warm(params) {
      await recoverIfLost()
      await submit(params)
    },
    async run(params): Promise<RunResult> {
      await recoverIfLost()
      const ms = await submit(params)
      if (lost) throw new Error(`device perdido (${lost})`)
      const pixels = await readback()
      return { pixels, width: w, height: h, ms }
    },
    dispose() {
      device.destroy()
    },
  }
}
