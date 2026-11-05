// Shared definitions for the Dither comparison: params, algorithm table and the CPU ports of the
// sequential algorithms (error diffusion and Riemersma) that WebGL2 cannot run as compute.

export interface Rgba { r: number; g: number; b: number; a: number }

export interface DitherParams {
  algorithm: string
  pixelSize: number
  levels: number
  brightness: number
  contrast: number
  mono: boolean
  monoColor: Rgba
}

export const DEFAULT_PARAMS: DitherParams = {
  algorithm: 'Bayer 16x16',
  pixelSize: 2,
  levels: 3,
  brightness: 100,
  contrast: 1,
  mono: false,
  monoColor: { r: 1, g: 1, b: 1, a: 1 },
}

export type Family = 'ord' | 'ed' | 'curve'

export const ALGORITHMS: { name: string; fam: Family; tile?: string; kernel?: keyof typeof ED_TAPS }[] = [
  { name: 'Bayer 2x2', fam: 'ord', tile: 'bayer2' },
  { name: 'Bayer 4x4', fam: 'ord', tile: 'bayer4' },
  { name: 'Bayer 8x8', fam: 'ord', tile: 'bayer8' },
  { name: 'Bayer 16x16', fam: 'ord', tile: 'bayer16' },
  { name: 'Blue Noise', fam: 'ord', tile: 'bluenoise' },
  { name: 'Threshold', fam: 'ord', tile: 'threshold' },
  { name: 'Atkinson', fam: 'ed', kernel: 'atkinson' },
  { name: 'Floyd-Steinberg', fam: 'ed', kernel: 'floyd' },
  { name: 'Sierra', fam: 'ed', kernel: 'sierra' },
  { name: 'Jarvis', fam: 'ed', kernel: 'jarvis' },
  { name: 'Riemersma', fam: 'curve' },
]

/** (dx, dy, weight) taps, same numbers as the WGSL `taps` arrays. */
export const ED_TAPS = {
  atkinson: [[1, 0, 0.125], [2, 0, 0.125], [-1, 1, 0.125], [0, 1, 0.125], [1, 1, 0.125], [0, 2, 0.125]],
  floyd: [[1, 0, 0.4375], [-1, 1, 0.1875], [0, 1, 0.3125], [1, 1, 0.0625]],
  sierra: [[1, 0, 0.15625], [2, 0, 0.09375], [-2, 1, 0.0625], [-1, 1, 0.125], [0, 1, 0.15625], [1, 1, 0.125], [2, 1, 0.0625], [-1, 2, 0.0625], [0, 2, 0.09375], [1, 2, 0.0625]],
  jarvis: [[1, 0, 0.14583333], [2, 0, 0.10416667], [-2, 1, 0.0625], [-1, 1, 0.10416667], [0, 1, 0.14583333], [1, 1, 0.10416667], [2, 1, 0.0625], [-2, 2, 0.02083333], [-1, 2, 0.0625], [0, 2, 0.10416667], [1, 2, 0.0625], [2, 2, 0.02083333]],
} as const

export function algoByName(name: string) {
  return ALGORITHMS.find((a) => a.name === name) ?? ALGORITHMS[2]
}

export function gridSize(dimX: number, dimY: number, pixelSize: number) {
  return { W: Math.max(1, Math.ceil(dimX / pixelSize)), H: Math.max(1, Math.ceil(dimY / pixelSize)) }
}

export interface RunResult {
  /** Top-row-first RGBA8, same size as the input. */
  pixels: Uint8ClampedArray
  width: number
  height: number
  /** Wall-clock ms for the dither work (GPU: submit -> done; CPU path: includes the CPU loop). */
  ms: number
  /** Optional breakdown, e.g. "CPU 12.3 ms". */
  detail?: string
}

export interface DitherBackend {
  readonly id: string
  readonly ok: boolean
  readonly note: string
  /** Optional: swap the input image (same size). */
  setInput?(src: ImageBitmap | HTMLCanvasElement): void
  /** Runs the algorithm once (warm: pipelines/tiles are created beforehand by `warm`). */
  run(params: DitherParams): Promise<RunResult>
  /** Optional: build pipelines/tiles for an algorithm so `run` measures steady-state time. */
  warm?(params: DitherParams): Promise<void>
  dispose(): void
}

// ---------------------------------------------------------------------------------------------
// CPU ports (WebGL2 has no compute). They mirror the WGSL line by line, including its quirks:
// the anti-diagonal scan also writes error into pixels that were already processed on the same or
// the previous diagonal (taps with dx < 0), exactly like the original.
// ---------------------------------------------------------------------------------------------

const f = Math.fround

/** WGSL `round`: halves go to the even integer. */
export function roundEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

interface Quant {
  levels: number
  mono: boolean
  monoColor: Rgba
  bright: number
  contrast: number
}

function makeQuant(p: DitherParams): Quant {
  return {
    levels: p.levels,
    mono: p.mono,
    monoColor: p.monoColor,
    bright: (p.brightness - 100) / 200,
    contrast: p.contrast,
  }
}

const lumaOf = (r: number, g: number, b: number) => f(f(f(r * 0.2126) + f(g * 0.7152)) + f(b * 0.0722))

/** Error diffusion over `buf` (RGBA float, W*H*4), mutated in place. Returns ms. */
export function ditherErrorDiffusion(buf: Float32Array, W: number, H: number, kernel: keyof typeof ED_TAPS, p: DitherParams): number {
  const t0 = performance.now()
  const q = makeQuant(p)
  const taps = ED_TAPS[kernel]
  const L = f(q.levels - 1)
  const quantize = (c: number) => Math.min(1, Math.max(0, f(roundEven(f(c * L)) / L)))
  const { bright, contrast } = q
  const mono = q.monoColor
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

  for (let k = 0; k < W + H - 1; k++) {
    const xLo = Math.max(0, k - (H - 1))
    const xHi = Math.min(W - 1, k)
    for (let x = xLo; x <= xHi; x++) {
      const y = k - x
      const i = (y * W + x) * 4
      let r = clamp01(f(f(f(f(buf[i] - 0.5) * contrast) + 0.5) + bright))
      let g = clamp01(f(f(f(f(buf[i + 1] - 0.5) * contrast) + 0.5) + bright))
      let b = clamp01(f(f(f(f(buf[i + 2] - 0.5) * contrast) + 0.5) + bright))
      let qr: number, qg: number, qb: number
      let er: number, eg: number, eb: number
      if (!q.mono) {
        qr = quantize(r); qg = quantize(g); qb = quantize(b)
        er = f(r - qr); eg = f(g - qg); eb = f(b - qb)
      } else {
        const lum = lumaOf(r, g, b)
        const ql = quantize(lum)
        qr = f(mono.r * ql); qg = f(mono.g * ql); qb = f(mono.b * ql)
        er = eg = eb = f(lum - ql)
      }
      buf[i] = qr; buf[i + 1] = qg; buf[i + 2] = qb
      for (let n = 0; n < taps.length; n++) {
        const nx = x + taps[n][0]
        const ny = y + taps[n][1]
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
          const j = (ny * W + nx) * 4
          const w = taps[n][2]
          buf[j] = f(buf[j] + f(er * w))
          buf[j + 1] = f(buf[j + 1] + f(eg * w))
          buf[j + 2] = f(buf[j + 2] + f(eb * w))
        }
      }
      void r; void g; void b
    }
  }
  return performance.now() - t0
}

function hilbertXY(d0: number, n: number): [number, number] {
  let d = d0 >>> 0
  let x = 0
  let y = 0
  let s = 1
  while (s < n) {
    const rx = (d >>> 1) & 1
    const ry = (d ^ rx) & 1
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y }
      const tmp = x; x = y; y = tmp
    }
    x += s * rx
    y += s * ry
    d = Math.floor(d / 4)
    s *= 2
  }
  return [x, y]
}

export function nextPowerOfTwo(n: number): number {
  return 1 << Math.ceil(Math.log2(Math.max(1, n)))
}

/** Riemersma dither along a Hilbert curve. `buf` mutated in place. Returns ms. */
export function ditherRiemersma(buf: Float32Array, W: number, H: number, p: DitherParams): number {
  const t0 = performance.now()
  const q = makeQuant(p)
  const L = f(q.levels - 1)
  const quantize = (c: number) => Math.min(1, Math.max(0, f(roundEven(f(c * L)) / L)))
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const { bright, contrast } = q
  const mono = q.monoColor

  const weights = new Float32Array(16)
  const ratio = f(Math.pow(1 / 16, 1 / 16))
  let sumW = 0
  for (let i = 0; i < 16; i++) {
    weights[i] = f(Math.pow(ratio, i + 1))
    sumW = f(sumW + weights[i])
  }
  for (let i = 0; i < 16; i++) weights[i] = f(weights[i] / sumW)

  const errR = new Float32Array(16)
  const errG = new Float32Array(16)
  const errB = new Float32Array(16)
  let head = 0
  const n = nextPowerOfTwo(Math.max(W, H))
  const total = n * n

  for (let step = 0; step < total; step++) {
    const [px, py] = hilbertXY(step, n)
    if (px >= W || py >= H) continue

    let ar = 0, ag = 0, ab = 0
    for (let kk = 0; kk < 16; kk++) {
      const h = (head + kk) % 16
      ar = f(ar + f(errR[h] * weights[kk]))
      ag = f(ag + f(errG[h] * weights[kk]))
      ab = f(ab + f(errB[h] * weights[kk]))
    }
    const i = (py * W + px) * 4
    const r = clamp01(f(f(f(f(f(buf[i] + ar) - 0.5) * contrast) + 0.5) + bright))
    const g = clamp01(f(f(f(f(f(buf[i + 1] + ag) - 0.5) * contrast) + 0.5) + bright))
    const b = clamp01(f(f(f(f(f(buf[i + 2] + ab) - 0.5) * contrast) + 0.5) + bright))
    let qr: number, qg: number, qb: number
    if (!q.mono) {
      qr = quantize(r); qg = quantize(g); qb = quantize(b)
      errR[head] = f(r - qr); errG[head] = f(g - qg); errB[head] = f(b - qb)
    } else {
      const lum = lumaOf(r, g, b)
      const ql = quantize(lum)
      qr = f(mono.r * ql); qg = f(mono.g * ql); qb = f(mono.b * ql)
      const e = f(lum - ql)
      errR[head] = e; errG[head] = e; errB[head] = e
    }
    head = (head + 15) % 16
    buf[i] = qr; buf[i + 1] = qg; buf[i + 2] = qb
  }
  return performance.now() - t0
}
