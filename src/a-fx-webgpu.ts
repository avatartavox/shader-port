// Option A (effects) — the two Figma modules, unchanged, chained by a small WebGPU runtime:
//   title texture -> Broadcast interference -> (rgba8unorm texture) -> Bloom -> canvas
// This is what Figma's ShaderEffect runtime does, minus HTML-in-Canvas (we upload a 2D-canvas raster).
import * as broadcast from './figma/broadcast'
import * as bloom from './figma/bloom'
import { BLOOM, BROADCAST, FX_SIZE, RENDER_SCALE } from './fx-shared'
import type { Backend } from './shared'

type Frame = Record<string, unknown> & { time: number; deltaTime: number; frame: number }

export async function createFigmaFxWebGPU(canvas: HTMLCanvasElement, title: HTMLCanvasElement): Promise<Backend> {
  const fail = (note: string): Backend => ({ id: 'A-fx', canvas, ok: false, note, render() {}, dispose() {} })

  if (!navigator.gpu) return fail('WebGPU no disponible en este navegador')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return fail('No se encontró adaptador WebGPU')
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu')
  if (!context) return fail('No se pudo crear el contexto webgpu')

  canvas.width = FX_SIZE.w
  canvas.height = FX_SIZE.h
  const format = navigator.gpu.getPreferredCanvasFormat()
  // Effects output premultiplied RGBA that must composite over the rings fill underneath.
  context.configure({ device, format, alphaMode: 'premultiplied' })

  const { w, h } = FX_SIZE
  const titleTex = device.createTexture({
    size: [w, h],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  device.queue.copyExternalImageToTexture(
    { source: title },
    { texture: titleTex, premultipliedAlpha: true },
    [w, h],
  )
  const midTex = device.createTexture({
    size: [w, h],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })

  const makeFrame = (params: unknown, input: GPUTexture, output: GPUTexture): Frame => ({
    input,
    output,
    params,
    state: {},
    time: 0,
    deltaTime: 16,
    frame: 0,
    renderScale: RENDER_SCALE,
    mousePosition: undefined,
  })
  const f1 = makeFrame(BROADCAST, titleTex, midTex)
  const f2 = makeFrame(BLOOM, midTex, context.getCurrentTexture())

  broadcast.setup(device, f1)
  bloom.setup(device, f2)

  return {
    id: 'A-fx',
    canvas,
    ok: true,
    note: `WebGPU · 2 módulos Figma encadenados · ${format}`,
    render(t: number, dt: number) {
      for (const f of [f1, f2]) {
        f.time = t
        f.deltaTime = dt
        f.frame++
      }
      broadcast.render(device, f1)
      f2.output = context.getCurrentTexture()
      bloom.render(device, f2)
    },
    dispose() {
      device.destroy()
    },
  }
}
