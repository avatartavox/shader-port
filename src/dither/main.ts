import '../style.css'
import { createDitherA } from './a-webgpu'
import { createDitherB } from './b-webgl2'
import { ALGORITHMS, DEFAULT_PARAMS, algoByName, type DitherBackend, type DitherParams, type RunResult } from './shared'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header>
    <h1>Dither · compute (WebGPU) vs WebGL2</h1>
    <p>Misma imagen de entrada (captura de Figma 1280×720). A = módulo de Figma sin cambios (compute). B = WebGL2: estilos ordenados en fragmento; difusión de error y Riemersma con un bucle en CPU.</p>
    <div class="controls">
      <label>Estilo <select id="algo">${ALGORITHMS.map((a) => `<option>${a.name}</option>`).join('')}</select></label>
      <label>Tamaño <input id="px" type="range" min="1" max="8" step="1" value="${DEFAULT_PARAMS.pixelSize}" /><output id="pxo"></output></label>
      <label>Niveles <input id="lv" type="range" min="2" max="8" step="1" value="${DEFAULT_PARAMS.levels}" /><output id="lvo"></output></label>
      <label>Brillo <input id="br" type="range" min="0" max="200" step="1" value="${DEFAULT_PARAMS.brightness}" /><output id="bro"></output></label>
      <label>Contraste <input id="ct" type="range" min="0.5" max="2" step="0.02" value="${DEFAULT_PARAMS.contrast}" /><output id="cto"></output></label>
      <label><input id="mono" type="checkbox" /> Mono</label>
    </div>
    <div class="bar">
      <button id="one">Ejecutar este estilo</button>
      <button id="all">Comparar los 11 estilos</button>
      <span id="status"></span>
    </div>
  </header>
  <main id="grid" class="dgrid"></main>
  <section class="table-wrap">
    <table id="table">
      <thead><tr><th>Estilo</th><th>Tipo</th><th>A · compute (ms)</th><th>B · WebGL2 (ms)</th><th>Detalle B</th><th>Diff A vs B (media · máx · % px &gt; 8)</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>`

const grid = document.querySelector<HTMLElement>('#grid')!
const mkPanel = (title: string, sub: string) => {
  const s = document.createElement('section')
  s.innerHTML = `<div class="head"><strong>${title}</strong><span>${sub}</span></div><canvas></canvas><div class="stat"></div>`
  grid.append(s)
  return { canvas: s.querySelector('canvas')!, stat: s.querySelector<HTMLElement>('.stat')! }
}
const pIn = mkPanel('Entrada', 'captura de Figma')
const pA = mkPanel('A · compute', 'WebGPU · módulo Figma')
const pB = mkPanel('B · WebGL2', 'fragmentos + CPU')
const pD = mkPanel('Diferencia ×8', '|A − B| amplificada')

const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!
const statusEl = $('status')
const tbody = document.querySelector<HTMLTableSectionElement>('#table tbody')!

function readParams(): DitherParams {
  return {
    algorithm: $<HTMLSelectElement>('algo').value,
    pixelSize: Number($<HTMLInputElement>('px').value),
    levels: Number($<HTMLInputElement>('lv').value),
    brightness: Number($<HTMLInputElement>('br').value),
    contrast: Number($<HTMLInputElement>('ct').value),
    mono: $<HTMLInputElement>('mono').checked,
    monoColor: { r: 1, g: 1, b: 1, a: 1 },
  }
}
const sync = () => {
  $('pxo').textContent = $<HTMLInputElement>('px').value
  $('lvo').textContent = $<HTMLInputElement>('lv').value
  $('bro').textContent = `${$<HTMLInputElement>('br').value}%`
  $('cto').textContent = $<HTMLInputElement>('ct').value
}
for (const id of ['px', 'lv', 'br', 'ct']) $(id).addEventListener('input', sync)
sync()

function draw(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, w: number, h: number) {
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0)
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let sum = 0
  let max = 0
  let over = 0
  const n = a.length / 4
  const vis = new Uint8ClampedArray(a.length)
  for (let i = 0; i < a.length; i += 4) {
    let d = 0
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]))
    sum += d
    if (d > max) max = d
    if (d > 8) over++
    vis[i] = vis[i + 1] = vis[i + 2] = Math.min(255, d * 8)
    vis[i + 3] = 255
  }
  return { mean: sum / n, max, pctOver: (over / n) * 100, vis }
}

let A: DitherBackend
let B: DitherBackend
let image: ImageBitmap

interface Row { a?: RunResult; b?: RunResult; err?: string; d?: ReturnType<typeof diff> }

async function runPair(p: DitherParams): Promise<Row> {
  const row: Row = {}
  const errs: string[] = []
  try {
    if (A.ok) {
      await A.warm?.(p)
      row.a = await A.run(p)
    } else errs.push(`A: ${A.note}`)
  } catch (e) {
    errs.push(`A: ${(e as Error).message}`)
  }
  try {
    if (B.ok) {
      await B.warm?.(p)
      row.b = await B.run(p)
    } else errs.push(`B: ${B.note}`)
  } catch (e) {
    errs.push(`B: ${(e as Error).message}`)
  }
  if (row.a && row.b) row.d = diff(row.a.pixels, row.b.pixels)
  if (errs.length) row.err = errs.join(' · ')
  return row
}

function show(row: Row) {
  if (row.a) draw(pA.canvas, row.a.pixels, row.a.width, row.a.height)
  if (row.b) draw(pB.canvas, row.b.pixels, row.b.width, row.b.height)
  if (row.d && row.a) draw(pD.canvas, row.d.vis, row.a.width, row.a.height)
  pA.stat.textContent = row.a ? `${row.a.ms.toFixed(1)} ms (envío → GPU terminado)` : '—'
  pB.stat.textContent = row.b ? `${row.b.ms.toFixed(1)} ms · ${row.b.detail ?? ''}` : '—'
  pD.stat.textContent = row.d ? `media ${row.d.mean.toFixed(2)} · máx ${row.d.max} · ${row.d.pctOver.toFixed(2)}% de px con diff > 8` : '—'
}

function famLabel(name: string) {
  const f = algoByName(name).fam
  return f === 'ord' ? 'ordenado (paralelo)' : f === 'ed' ? 'difusión de error (secuencial)' : 'curva Hilbert (secuencial)'
}

function addRow(name: string, row: Row) {
  const tr = document.createElement('tr')
  const d = row.d
  tr.innerHTML = `
    <td>${name}</td>
    <td>${famLabel(name)}</td>
    <td>${row.a ? row.a.ms.toFixed(1) : '—'}</td>
    <td>${row.b ? row.b.ms.toFixed(1) : '—'}</td>
    <td>${row.b?.detail ?? ''}${row.err ? ` <em>⚠ ${row.err}</em>` : ''}</td>
    <td>${d ? `${d.mean.toFixed(2)} · ${d.max} · ${d.pctOver.toFixed(2)}%` : '—'}</td>`
  tbody.append(tr)
}

const buttons = [$('one'), $('all')]
const busy = (on: boolean) => buttons.forEach((b) => ((b as HTMLButtonElement).disabled = on))

async function runOne() {
  busy(true)
  const p = readParams()
  statusEl.textContent = `Ejecutando ${p.algorithm}…`
  const row = await runPair(p)
  show(row)
  statusEl.textContent = row.err ? `Listo con avisos: ${row.err}` : 'Listo'
  busy(false)
  return row
}

async function runAll() {
  busy(true)
  tbody.innerHTML = ''
  const base = readParams()
  const results: Record<string, Row> = {}
  for (const algo of ALGORITHMS) {
    statusEl.textContent = `Ejecutando ${algo.name}…`
    const row = await runPair({ ...base, algorithm: algo.name })
    results[algo.name] = row
    addRow(algo.name, row)
    show(row)
  }
  statusEl.textContent = 'Listo'
  busy(false)
  return results
}

$('one').addEventListener('click', () => void runOne())
$('all').addEventListener('click', () => void runAll())

async function start() {
  const blob = await (await fetch('/ref/figma-full.png')).blob()
  image = await createImageBitmap(blob)
  const off = document.createElement('canvas')
  off.width = image.width
  off.height = image.height
  const ctx = off.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0)
  draw(pIn.canvas, ctx.getImageData(0, 0, off.width, off.height).data, off.width, off.height)
  pIn.stat.textContent = `${image.width}×${image.height}`

  A = await createDitherA(image)
  B = createDitherB(image)
  statusEl.textContent = `A: ${A.ok ? 'ok' : `⚠ ${A.note}`} · B: ${B.ok ? 'ok' : `⚠ ${B.note}`}`
  ;(window as unknown as Record<string, unknown>).__dither = { runOne, runAll, runPair, readParams }
}
start().catch((e: unknown) => {
  statusEl.textContent = `Error al iniciar: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
})
