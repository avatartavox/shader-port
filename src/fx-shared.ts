// Shared bits for the text-effect chain: Broadcast interference -> Bloom, applied to the title
// "Designing with AI" (Figma node 1:4) which sits on top of the rings fill (node 1:3).

/** Logical size of the Figma frame and the text layer inside it (px). */
export const FRAME = { w: 1920, h: 1080 }
export const TEXT_BOX = { x: 367, y: 399, w: 1185, h: 228 }

/** Device px per logical px. 0.5 for the side-by-side page; `?scale=1` renders at the full 1920x1080 frame. */
export const RENDER_SCALE = Number(new URLSearchParams(location.search).get('scale')) || 0.5
export const FILL_SIZE = { w: FRAME.w * RENDER_SCALE, h: FRAME.h * RENDER_SCALE }
export const FX_SIZE = {
  w: Math.ceil(TEXT_BOX.w * RENDER_SCALE),
  h: Math.ceil(TEXT_BOX.h * RENDER_SCALE),
}

export const TITLE = 'Designing with AI'
export const TITLE_FONT = '"Afacad Flux"'
export const TITLE_SIZE = 170.634

/** Effect 1 params, verbatim from get_design_context(1:3). */
export const BROADCAST = {
  playbackSpeed: 1.899999976158142,
  noiseIntensity: 0.23999999463558197,
  effectStrength: 0.8500000238418579,
  animationPhase: 20.34000015258789,
  screenCurvature: 0.07999999821186066,
  glitchDuration: 0.17000000178813934,
  rgbSeparation: 4.5,
  scanlineIntensity: 0.07999999821186066,
  wavePosition: 36.5,
  grainSize: 0.5,
  ghostingStrength: 0.2800000011920929,
  scanlineSpacing: 12.5,
  glitchFrequency: 2,
  waveStrength: 15,
  waveWidth: 14,
  flickerIntensity: 0.2199999988079071,
  glitchStrength: 20,
}

/** Effect 2 params: the values applied to the node through the plugin API. */
export const BLOOM = {
  threshold: 40,
  intensity: 55,
  softness: 60,
  tint: { r: 0.25, g: 0.85, b: 1, a: 1 },
  vignetteStrength: 0,
  vignetteSoftness: 50,
  origin: { x: 50, y: 50, radius: 300 },
}

/**
 * Rasterises the title into a canvas the size of the text layer (at RENDER_SCALE).
 * Figma feeds the effects an HTML-in-Canvas snapshot of the DOM text; here we draw it ourselves,
 * so glyph positioning/antialiasing can differ slightly.
 */
export async function rasterizeTitle(): Promise<HTMLCanvasElement> {
  await document.fonts.load(`400 ${TITLE_SIZE}px ${TITLE_FONT}`)
  await document.fonts.ready

  const canvas = document.createElement('canvas')
  canvas.width = FX_SIZE.w
  canvas.height = FX_SIZE.h
  const ctx = canvas.getContext('2d')!
  ctx.scale(RENDER_SCALE, RENDER_SCALE)
  ctx.font = `400 ${TITLE_SIZE}px ${TITLE_FONT}, sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'alphabetic'

  // "line-height: normal" centres the font's ascent+descent box inside the 228px layer.
  const m = ctx.measureText(TITLE)
  const asc = m.fontBoundingBoxAscent
  const desc = m.fontBoundingBoxDescent
  const baseline = (TEXT_BOX.h - (asc + desc)) / 2 + asc
  ctx.fillText(TITLE, 0, baseline)
  return canvas
}

export function fontLoaded(): boolean {
  return document.fonts.check(`400 ${TITLE_SIZE}px ${TITLE_FONT}`)
}
