// Option A — the Figma shader module, untouched, driven by a tiny WebGPU runtime.
// The module expects `frame = { input, output, params, state, time, deltaTime, frame, mousePosition }`.
import * as shader from './figma/specular-rings'
import { PARAMS, type Backend, type Pointer } from './shared'

export async function createFigmaWebGPU(canvas: HTMLCanvasElement): Promise<Backend> {
  const fail = (note: string): Backend => ({
    id: 'A', canvas, ok: false, note, render() {}, dispose() {},
  })

  if (!navigator.gpu) return fail('WebGPU no disponible en este navegador')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return fail('No se encontró adaptador WebGPU')
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu')
  if (!context) return fail('No se pudo crear el contexto webgpu')

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  const frame: Record<string, unknown> = {
    input: null,
    output: context.getCurrentTexture(),
    params: PARAMS,
    state: {},
    time: 0,
    deltaTime: 16,
    frame: 0,
    mousePosition: undefined,
  }
  shader.setup(device, frame)

  return {
    id: 'A',
    canvas,
    ok: true,
    note: `WebGPU · formato ${format}`,
    render(t: number, dt: number, pointer: Pointer) {
      frame.output = context.getCurrentTexture()
      frame.time = t
      frame.deltaTime = dt
      frame.frame = (frame.frame as number) + 1
      frame.mousePosition = pointer ? { x: pointer.x * canvas.width, y: pointer.y * canvas.height } : undefined
      shader.render(device, frame)
    },
    dispose() {
      device.destroy()
    },
  }
}
