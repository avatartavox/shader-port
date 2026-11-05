import './style.css'
import { createFigmaFxWebGPU } from './a-fx-webgpu'
import { createFigmaWebGPU } from './a-webgpu-figma'
import { createWebGL2Fx } from './b-fx-webgl2'
import { createWebGL2 } from './b-webgl2'
import { createThreeFx } from './c-fx-three'
import { createThree } from './c-three'
import { BROADCAST, FILL_SIZE, FRAME, FX_SIZE, TEXT_BOX, fontLoaded, rasterizeTitle } from './fx-shared'
import type { Backend, Pointer } from './shared'

const FROZEN_T = 3000

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(3)}%`
const fxCss = `left:${pct(TEXT_BOX.x, FRAME.w)};top:${pct(TEXT_BOX.y, FRAME.h)};width:${pct(TEXT_BOX.w, FRAME.w)};height:${pct(TEXT_BOX.h, FRAME.h)}`

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header>
    <h1>Specular rings + Broadcast interference + Bloom · port comparison</h1>
    <p>Fill (nodo 1:3) + texto con 2 efectos apilados (nodo 1:4: Broadcast → Bloom). Mueve el mouse sobre cualquier panel: los tres reaccionan igual.</p>
    <div class="bar">
      <button id="freeze">Congelar t=3s y comparar píxeles</button>
      <button id="resume" hidden>Reanudar</button>
      <span id="fps"></span>
      <span id="font"></span>
    </div>
    <pre id="diff" hidden></pre>
  </header>
  <main id="grid"></main>`

const grid = document.querySelector<HTMLElement>('#grid')!

interface Panel {
  label: string
  fill: Backend | null
  fx: Backend | null
  fillCanvas: HTMLCanvasElement
  fxCanvas: HTMLCanvasElement
  stack: HTMLElement
  statEl: HTMLElement
  jsMs: number
}

function addPanel(title: string, subtitle: string): Panel {
  const section = document.createElement('section')
  section.innerHTML = `
    <div class="head"><strong>${title}</strong><span>${subtitle}</span></div>
    <div class="stack">
      <canvas class="fill" width="${FILL_SIZE.w}" height="${FILL_SIZE.h}"></canvas>
      <canvas class="fx" width="${FX_SIZE.w}" height="${FX_SIZE.h}" style="${fxCss}"></canvas>
    </div>
    <div class="stat"></div>`
  grid.append(section)
  return {
    label: title,
    fill: null,
    fx: null,
    fillCanvas: section.querySelector('canvas.fill')!,
    fxCanvas: section.querySelector('canvas.fx')!,
    stack: section.querySelector('.stack')!,
    statEl: section.querySelector('.stat')!,
    jsMs: 0,
  }
}

// Reference: Figma screenshot of node 1:3 with both effects applied (a single arbitrary time).
{
  const section = document.createElement('section')
  section.innerHTML = `
    <div class="head"><strong>Referencia Figma</strong><span>get_screenshot(1:3) · un frame cualquiera</span></div>
    <img src="/ref/figma-full.png" alt="Figma reference" />
    <div class="stat">Captura del nodo con Broadcast + Bloom. Es un instante distinto, así que sirve para el look, no para el diff.</div>`
  grid.append(section)
}

const A = addPanel('A · Módulos de Figma + runtime propio', 'WebGPU · WGSL original')
const B = addPanel('B · WebGL2 puro', 'GLSL ES 3.00 · 0 dependencias')
const C = addPanel('C · Three.js', 'ShaderMaterial · GLSL')
const panels = [A, B, C]

// Shared pointer (normalised), mirrored to every panel.
let pointer: Pointer = null
for (const p of panels) {
  p.stack.addEventListener('pointermove', (e) => {
    const r = p.stack.getBoundingClientRect()
    pointer = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  })
  p.stack.addEventListener('pointerleave', () => {
    pointer = null
  })
}

let frozen = false
let frozenFrames = 0
const diffEl = document.querySelector<HTMLPreElement>('#diff')!
const freezeBtn = document.querySelector<HTMLButtonElement>('#freeze')!
const resumeBtn = document.querySelector<HTMLButtonElement>('#resume')!
const fpsEl = document.querySelector<HTMLSpanElement>('#fps')!
const fontEl = document.querySelector<HTMLSpanElement>('#font')!

freezeBtn.addEventListener('click', () => {
  frozen = true
  frozenFrames = 6
  freezeBtn.hidden = true
  resumeBtn.hidden = false
  diffEl.hidden = false
  diffEl.textContent = 'Renderizando frame fijo…'
})
resumeBtn.addEventListener('click', () => {
  frozen = false
  freezeBtn.hidden = false
  resumeBtn.hidden = true
  diffEl.hidden = true
})

const OW = 480
const OH = 270
const off = document.createElement('canvas')
off.width = OW
off.height = OH
const offCtx = off.getContext('2d', { willReadFrequently: true })!

/** Draws fill + fx the way the page composites them, in the same task as the render (WebGPU needs that). */
function readComposite(p: Panel): Uint8ClampedArray {
  offCtx.clearRect(0, 0, OW, OH)
  offCtx.drawImage(p.fillCanvas, 0, 0, OW, OH)
  offCtx.drawImage(
    p.fxCanvas,
    (TEXT_BOX.x / FRAME.w) * OW,
    (TEXT_BOX.y / FRAME.h) * OH,
    (TEXT_BOX.w / FRAME.w) * OW,
    (TEXT_BOX.h / FRAME.h) * OH,
  )
  return offCtx.getImageData(0, 0, OW, OH).data
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
const fxRect: Rect = {
  x0: Math.floor((TEXT_BOX.x / FRAME.w) * OW),
  y0: Math.floor((TEXT_BOX.y / FRAME.h) * OH),
  x1: Math.ceil(((TEXT_BOX.x + TEXT_BOX.w) / FRAME.w) * OW),
  y1: Math.ceil(((TEXT_BOX.y + TEXT_BOX.h) / FRAME.h) * OH),
}
const fullRect: Rect = { x0: 0, y0: 0, x1: OW, y1: OH }

function diff(ref: Uint8ClampedArray, other: Uint8ClampedArray, r: Rect) {
  let sum = 0
  let max = 0
  let over = 0
  let n = 0
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * OW + x) * 4
      let d = 0
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(ref[i + k] - other[i + k]))
      sum += d
      if (d > max) max = d
      if (d > 8) over++
      n++
    }
  }
  return { mean: sum / n, max, pctOver: (over / n) * 100 }
}

let lastReport = ''
type Snaps = Map<Panel, Uint8ClampedArray>
const snapsFull: Snaps = new Map()
const snapsDet: Snaps = new Map()

// The Broadcast shader derives noise, flicker and glitch tears from `fract(sin(x) * 43758.5)`.
// `sin` of large arguments is implementation-defined, so WGSL and GLSL pick different random values.
// The second pass switches those terms off to measure the deterministic part (geometry, wave, bloom).
const HASH_OFF = { noiseIntensity: 0, flickerIntensity: 0, glitchStrength: 0 }
const broadcastSaved = { ...BROADCAST }

function capture(into: Snaps) {
  for (const p of panels) if (p.fill?.ok && p.fx?.ok) into.set(p, readComposite(p).slice())
}

function section(title: string, snaps: Snaps): string[] {
  const ref = snaps.get(A)
  const lines = [title]
  for (const p of [B, C]) {
    const px = snaps.get(p)
    if (!ref || !px) {
      lines.push(`  ${p.label.split(' ·')[0]}: no disponible`)
      continue
    }
    const t = diff(ref, px, fxRect)
    const f = diff(ref, px, fullRect)
    const name = p.label.split(' ·')[0]
    lines.push(
      `  ${name} · texto con efectos: media ${t.mean.toFixed(2)} · máx ${t.max} · ${t.pctOver.toFixed(2)}% de px con diff > 8`,
      `  ${name} · frame completo:    media ${f.mean.toFixed(2)} · máx ${f.max} · ${f.pctOver.toFixed(2)}% de px con diff > 8`,
    )
  }
  return lines
}

function reportDiff() {
  if (!A.fx?.ok || !A.fill?.ok) {
    diffEl.textContent = 'A no está disponible (sin WebGPU): no hay referencia contra la que comparar.'
    return
  }
  lastReport = [
    'Diferencia vs A (WebGPU, módulos Figma originales) · t = 3 s, sin mouse · 0–255 por canal',
    ...section('Con todo activo (incluye ruido/flicker/tears basados en sin-hash):', snapsFull),
    ...section('Sin ruido, flicker ni tears (parte determinista):', snapsDet),
  ].join('\n')
  diffEl.textContent = lastReport
}

let last = performance.now()
let fpsEma = 60

function loop(now: number) {
  const dt = now - last
  last = now
  fpsEma = fpsEma * 0.95 + (1000 / Math.max(dt, 1)) * 0.05

  const t = frozen ? FROZEN_T : now
  const d = frozen ? 16 : dt
  const ptr = frozen ? null : pointer

  for (const p of panels) {
    const t0 = performance.now()
    if (p.fill?.ok) p.fill.render(t, d, ptr)
    if (p.fx?.ok) p.fx.render(t, d, null)
    p.jsMs = p.jsMs * 0.9 + (performance.now() - t0) * 0.1
  }

  // Read back after all panels rendered, still in the same task (WebGPU canvases need that).
  if (frozen && frozenFrames > 0) {
    if (frozenFrames === 4) capture(snapsFull)
    if (frozenFrames === 3) Object.assign(BROADCAST, HASH_OFF)
    if (frozenFrames === 1) {
      capture(snapsDet)
      Object.assign(BROADCAST, broadcastSaved)
    }
    if (--frozenFrames === 0) reportDiff()
  }

  fpsEl.textContent = `${fpsEma.toFixed(0)} fps`
  for (const p of panels) {
    const bits = [p.fill, p.fx].map((b) => (b ? (b.ok ? b.note : `⚠ ${b.note}`) : '…'))
    p.statEl.innerHTML = `${bits.join('<br>')}<br>JS (fill + texto): ${p.jsMs.toFixed(2)} ms/frame`
  }
  requestAnimationFrame(loop)
}

async function start() {
  const title = await rasterizeTitle()
  fontEl.textContent = fontLoaded() ? 'fuente: Afacad Flux ✓' : 'fuente: Afacad Flux ✗ (usando fallback)'

  A.fill = await createFigmaWebGPU(A.fillCanvas)
  A.fx = await createFigmaFxWebGPU(A.fxCanvas, title)
  B.fill = createWebGL2(B.fillCanvas)
  B.fx = createWebGL2Fx(B.fxCanvas, title)
  C.fill = createThree(C.fillCanvas)
  C.fx = createThreeFx(C.fxCanvas, title)
  // Test hook: lets the console drive backends deterministically (fixed t).
  ;(window as unknown as { __panels: Panel[]; __report: () => string }).__panels = panels
  ;(window as unknown as { __report: () => string }).__report = () => lastReport
  ;(window as unknown as { __snaps: unknown }).__snaps = { snapsFull, snapsDet }
  requestAnimationFrame(loop)
}
start().catch((e: unknown) => {
  diffEl.hidden = false
  diffEl.textContent = `Error al iniciar: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
  console.error(e)
})
