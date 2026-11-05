// Option B — WebGL2. There is no compute, so the work is split by what the hardware can do:
//   * ordered styles (Bayer / Blue noise / Threshold): every pixel is independent -> one fragment pass;
//   * error diffusion + Riemersma: inherently sequential -> GPU "load" pass, CPU loop, GPU "present".
import { getTile } from '../figma/dither'
import {
  algoByName, ditherErrorDiffusion, ditherRiemersma, gridSize,
  type DitherBackend, type DitherParams, type RunResult,
} from './shared'

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`
const VERT = `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const ORDERED = `${HEADER}
uniform sampler2D u_input;
uniform sampler2D u_tile;
uniform vec2 u_dim;
uniform float u_pixelSize;
uniform ivec2 u_cells;
uniform int u_tileSize;
uniform float u_levels;
uniform int u_mode;
uniform float u_bright;
uniform float u_contrast;
uniform vec3 u_mono;
out vec4 outColor;

float quantizeT(float c, float t) {
  float L = u_levels - 1.0;
  float off = (t - 0.5) / L;
  return clamp(roundEven((c + off) * L) / L, 0.0, 1.0);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_dim.x, 1.0 - gl_FragCoord.y / u_dim.y);
  int cx = clamp(int(floor(uv.x * u_dim.x / u_pixelSize)), 0, u_cells.x - 1);
  int cy = clamp(int(floor(uv.y * u_dim.y / u_pixelSize)), 0, u_cells.y - 1);
  vec2 center = (vec2(float(cx), float(cy)) + 0.5) * u_pixelSize / u_dim;
  vec4 s = textureLod(u_input, clamp(center, vec2(0.0), vec2(1.0)), 0.0);
  vec3 rgb = vec3(0.0);
  if (s.a > 0.0) { rgb = s.rgb / s.a; }
  vec3 c = clamp((rgb - 0.5) * u_contrast + 0.5 + u_bright, vec3(0.0), vec3(1.0));
  float th = texelFetch(u_tile, ivec2(cx % u_tileSize, cy % u_tileSize), 0).r;
  vec3 q;
  if (u_mode == 0) {
    q = u_mono * quantizeT(luma(c), th);
  } else {
    q = vec3(quantizeT(c.r, th), quantizeT(c.g, th), quantizeT(c.b, th));
  }
  outColor = s.a <= 0.0 ? vec4(0.0) : vec4(q * s.a, s.a);
}`

const LOAD = `${HEADER}
uniform sampler2D u_input;
uniform vec2 u_dim;
uniform float u_pixelSize;
out vec4 outColor;
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 center = (cell + 0.5) * u_pixelSize / u_dim;
  vec4 s = textureLod(u_input, clamp(center, vec2(0.0), vec2(1.0)), 0.0);
  vec3 rgb = vec3(0.0);
  if (s.a > 0.0) { rgb = s.rgb / s.a; }
  outColor = vec4(rgb, s.a);
}`

const PRESENT = `${HEADER}
uniform sampler2D u_buf;
uniform vec2 u_dim;
uniform float u_pixelSize;
uniform ivec2 u_cells;
out vec4 outColor;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_dim.x, 1.0 - gl_FragCoord.y / u_dim.y);
  int cx = clamp(int(floor(uv.x * u_dim.x / u_pixelSize)), 0, u_cells.x - 1);
  int cy = clamp(int(floor(uv.y * u_dim.y / u_pixelSize)), 0, u_cells.y - 1);
  vec4 p = texelFetch(u_buf, ivec2(cx, cy), 0);
  outColor = p.a <= 0.0 ? vec4(0.0) : vec4(p.rgb * p.a, p.a);
}`

export function createDitherB(image: ImageBitmap): DitherBackend {
  const fail = (note: string): DitherBackend => ({
    id: 'B', ok: false, note, run: async () => { throw new Error(note) }, dispose() {},
  })

  const w = image.width
  const h = image.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: true })
  if (!gl) return fail('WebGL2 no disponible')
  const floatRT = gl.getExtension('EXT_color_buffer_float')

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile error')
    return s
  }
  const program = (frag: string) => {
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
    const cache = new Map<string, WebGLUniformLocation | null>()
    return { p, u: (n: string) => (cache.has(n) ? cache.get(n)! : (cache.set(n, gl.getUniformLocation(p, n)), cache.get(n)!)) }
  }

  let ordered: ReturnType<typeof program>
  let load: ReturnType<typeof program>
  let present: ReturnType<typeof program>
  try {
    ordered = program(ORDERED)
    load = program(LOAD)
    present = program(PRESENT)
  } catch (e) {
    return fail(`GLSL: ${(e as Error).message}`)
  }

  const tex = (internal: number, tw: number, th: number, format: number, type: number, data: ArrayBufferView | null, filter: number) => {
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, format, type, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  // Input image (bilinear like the Figma sampler). ImageBitmap uploads ignore the UNPACK_* flags.
  const inputTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, inputTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const tileTextures = new Map<string, { tex: WebGLTexture; size: number }>()
  const tileFor = (name: string) => {
    let t = tileTextures.get(name)
    if (!t) {
      const tile = getTile(name) as { data: Float32Array; size: number }
      t = { tex: tex(gl.R32F, tile.size, tile.size, gl.RED, gl.FLOAT, tile.data, gl.NEAREST), size: tile.size }
      tileTextures.set(name, t)
    }
    return t
  }

  const makeFbo = (t: WebGLTexture) => {
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
    return fbo
  }
  const outTex = tex(gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.NEAREST)
  const outFbo = makeFbo(outTex)

  const bindTex = (unit: number, t: WebGLTexture, loc: WebGLUniformLocation | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.uniform1i(loc, unit)
  }
  const mono = (p: DitherParams, loc: WebGLUniformLocation | null) => gl.uniform3f(loc, p.monoColor.r, p.monoColor.g, p.monoColor.b)

  const readOut = (): Uint8ClampedArray => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo)
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    return out
  }

  // Float working buffer for the CPU path, reallocated when the grid changes.
  let bufW = 0
  let bufH = 0
  let bufTex: WebGLTexture | null = null
  let bufFbo: WebGLFramebuffer | null = null
  const ensureBuf = (W: number, H: number) => {
    if (bufTex && bufW === W && bufH === H) return
    if (bufTex) gl.deleteTexture(bufTex)
    if (bufFbo) gl.deleteFramebuffer(bufFbo)
    bufTex = tex(gl.RGBA32F, W, H, gl.RGBA, gl.FLOAT, null, gl.NEAREST)
    bufFbo = makeFbo(bufTex)
    bufW = W
    bufH = H
  }

  const drawTri = () => gl.drawArrays(gl.TRIANGLES, 0, 3)
  // gl.finish() is a no-op in Chrome; reading one pixel from the bound target really waits for the GPU.
  const syncGpu = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))

  const runOrdered = (p: DitherParams, W: number, H: number, tileName: string) => {
    const tile = tileFor(tileName)
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(ordered.p)
    bindTex(0, inputTex, ordered.u('u_input'))
    bindTex(1, tile.tex, ordered.u('u_tile'))
    gl.uniform2f(ordered.u('u_dim'), w, h)
    gl.uniform1f(ordered.u('u_pixelSize'), p.pixelSize)
    gl.uniform2i(ordered.u('u_cells'), W, H)
    gl.uniform1i(ordered.u('u_tileSize'), tile.size)
    gl.uniform1f(ordered.u('u_levels'), p.levels)
    gl.uniform1i(ordered.u('u_mode'), p.mono ? 0 : 1)
    gl.uniform1f(ordered.u('u_bright'), (p.brightness - 100) / 200)
    gl.uniform1f(ordered.u('u_contrast'), p.contrast)
    mono(p, ordered.u('u_mono'))
    drawTri()
    syncGpu()
  }

  const runSequential = (p: DitherParams, W: number, H: number, kind: 'ed' | 'curve', kernel?: Parameters<typeof ditherErrorDiffusion>[3]) => {
    ensureBuf(W, H)
    // 1) GPU load pass into a float buffer, then read it back (sync point).
    const t0 = performance.now()
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufFbo)
    gl.viewport(0, 0, W, H)
    gl.useProgram(load.p)
    bindTex(0, inputTex, load.u('u_input'))
    gl.uniform2f(load.u('u_dim'), w, h)
    gl.uniform1f(load.u('u_pixelSize'), p.pixelSize)
    drawTri()
    const data = new Float32Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, data)
    const t1 = performance.now()
    // 2) CPU loop (the part compute would do on the GPU).
    const cpuMs = kind === 'ed' ? ditherErrorDiffusion(data, W, H, kernel!, p) : ditherRiemersma(data, W, H, p)
    // 3) Upload + present pass.
    const t2 = performance.now()
    gl.bindTexture(gl.TEXTURE_2D, bufTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, data)
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(present.p)
    bindTex(0, bufTex!, present.u('u_buf'))
    gl.uniform2f(present.u('u_dim'), w, h)
    gl.uniform1f(present.u('u_pixelSize'), p.pixelSize)
    gl.uniform2i(present.u('u_cells'), W, H)
    drawTri()
    syncGpu()
    const t3 = performance.now()
    return `GPU load+readback ${(t1 - t0).toFixed(1)} ms · CPU ${cpuMs.toFixed(1)} ms · upload+present ${(t3 - t2).toFixed(1)} ms`
  }

  const exec = (p: DitherParams): { ms: number; detail?: string } => {
    const algo = algoByName(p.algorithm)
    const { W, H } = gridSize(w, h, p.pixelSize)
    const t0 = performance.now()
    if (algo.fam === 'ord') {
      runOrdered(p, W, H, algo.tile!)
      return { ms: performance.now() - t0, detail: '1 pasada de fragmentos' }
    }
    if (!floatRT) throw new Error('EXT_color_buffer_float no disponible: no hay buffer float para el camino CPU')
    const detail = runSequential(p, W, H, algo.fam === 'ed' ? 'ed' : 'curve', algo.kernel)
    return { ms: performance.now() - t0, detail }
  }

  return {
    id: 'B',
    ok: true,
    note: 'WebGL2 · ordenados en fragmento; difusión de error y Riemersma en CPU',
    async warm(p) {
      exec(p)
    },
    async run(p): Promise<RunResult> {
      const { ms, detail } = exec(p)
      return { pixels: readOut(), width: w, height: h, ms, detail }
    },
    dispose() {
      gl.deleteProgram(ordered.p)
      gl.deleteProgram(load.p)
      gl.deleteProgram(present.p)
    },
  }
}
