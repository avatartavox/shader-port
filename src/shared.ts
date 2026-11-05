// Shared between options B (WebGL2) and C (Three.js): the exact param values
// Figma holds on node 1:3, plus the pointer-energy + uniform packing logic that the
// Figma module runs internally (ported 1:1 from its render()).

export type Rgba = { r: number; g: number; b: number; a: number }

export interface RingParams {
  rippleDecay: number
  grain: number
  idleRipple: number
  lightB: Rgba
  variation: number
  ringCount: number
  rippleSpeed: number
  lightAngle: number
  centerX: number
  centerY: number
  background: Rgba
  rippleAmp: number
  drift: number
  specPower: number
  rippleFreq: number
  rippleFalloff: number
  rippleGlow: number
  glow: number
  lineWidth: number
  ringFade: number
  sensitivity: number
  lightA: Rgba
  ambient: number
}

// Verbatim from get_design_context(1:3).
export const PARAMS: RingParams = {
  rippleDecay: 1.899999976158142,
  grain: 0,
  idleRipple: 0.15000000596046448,
  lightB: { r: 0.25, g: 0.8500000238418579, b: 1, a: 1 },
  variation: 0.75,
  ringCount: 4,
  rippleSpeed: 7.5,
  lightAngle: -154,
  centerX: 48,
  centerY: 50,
  background: { r: 0, g: 0, b: 0.009999999776482582, a: 1 },
  rippleAmp: 0.054999999701976776,
  drift: 0.25,
  specPower: 7,
  rippleFreq: 15,
  rippleFalloff: 4.5,
  rippleGlow: 1,
  glow: 2,
  lineWidth: 0.019999999552965164,
  ringFade: 1.9500000476837158,
  sensitivity: 2.6000001430511475,
  lightA: { r: 0.10000000149011612, g: 0.30000001192092896, b: 1, a: 1 },
  ambient: 0,
}

/** Normalised pointer (0..1 over the canvas), or null when the pointer is elsewhere. */
export type Pointer = { x: number; y: number } | null

export interface Backend {
  readonly id: string
  readonly canvas: HTMLCanvasElement
  /** false when the backend could not start (see note). */
  readonly ok: boolean
  readonly note: string
  /** t in ms (absolute clock), dt in ms since previous frame. */
  render(t: number, dt: number, pointer: Pointer): void
  dispose(): void
}

/** Pointer-speed driven ripple energy, same maths as the Figma module. */
export class RippleState {
  private energy = 0
  private prevX: number | null = null
  private prevY = 0

  step(mx: number, my: number, h: number, dtMs: number, p: RingParams): number {
    const dt = Math.min(0.5, Math.max(0, dtMs * 0.001))
    if (this.prevX == null) {
      this.prevX = mx
      this.prevY = my
    }
    const dx = mx - this.prevX
    const dy = my - this.prevY
    const speed = Math.sqrt(dx * dx + dy * dy) / h
    this.prevX = mx
    this.prevY = my
    this.energy = Math.min(1, this.energy * Math.exp(-dt * p.rippleDecay) + speed * 6 * p.sensitivity)
    return Math.max(this.energy, p.idleRipple)
  }
}

export const UNIFORM_NAMES = ['colorA', 'colorB', 'bg', 'view', 'ring', 'look', 'mouse', 'wave', 'misc'] as const

/** Packs the 9 x vec4 uniform block exactly like the Figma module does. */
export function packUniforms(
  w: number,
  h: number,
  tMs: number,
  dtMs: number,
  pointer: Pointer,
  ripple: RippleState,
  p: RingParams,
): Float32Array {
  const aspect = w / h
  const cxUV = p.centerX / 100
  const cyUV = p.centerY / 100
  const mx = pointer ? pointer.x * w : cxUV * w
  const my = pointer ? pointer.y * h : cyUV * h
  const shown = ripple.step(mx, my, h, dtMs, p)
  const angle = (p.lightAngle * Math.PI) / 180
  return new Float32Array([
    p.lightA.r, p.lightA.g, p.lightA.b, 1,
    p.lightB.r, p.lightB.g, p.lightB.b, 1,
    p.background.r, p.background.g, p.background.b, 1,
    aspect, w, h, tMs * 0.001,
    (cxUV - 0.5) * aspect, cyUV - 0.5, p.ringCount, p.lineWidth,
    p.glow, angle, p.specPower, p.ringFade,
    (mx / w - 0.5) * aspect, my / h - 0.5, shown, p.rippleAmp,
    p.rippleFreq, p.rippleSpeed, p.rippleFalloff, p.grain,
    p.ambient, p.variation, p.rippleGlow, p.drift,
  ])
}

/** GLSL port of fs_main (shared by WebGL2 and Three.js). Needs the u_* vec4 uniforms. */
export const GLSL_UNIFORMS = UNIFORM_NAMES.map((n) => `uniform vec4 u_${n};`).join('\n')

export const GLSL_SHADE = /* glsl */ `
float hash21(vec2 p) {
  vec2 q = fract(p * vec2(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

vec3 shade(vec2 fragCoord) {
  float aspect = u_view.x;
  vec2 res = u_view.yz;
  float t = u_view.w;
  // WebGPU quad has uv.y = 0 at the top; gl_FragCoord.y = 0 is the bottom.
  vec2 uv = vec2(fragCoord.x / res.x, 1.0 - fragCoord.y / res.y);
  vec2 p = (uv - vec2(0.5)) * vec2(aspect, 1.0);

  vec2 q = p - u_ring.xy;
  float r = length(q);

  float dm = length(p - u_mouse.xy);
  float phase = dm * u_wave.x - t * u_wave.y;
  float atten = exp(-dm * u_wave.z);
  float energy = u_mouse.z;
  float disp = u_mouse.w * energy * atten * sin(phase);
  float r2 = r + disp;

  float s = r2 * u_ring.z - t * u_misc.w;
  float idx = floor(s);
  float dl = abs(fract(s) - 0.5);
  float lw = max(u_ring.w, 0.002);
  float core = exp(-pow(dl / lw, 2.0));
  float halo = u_look.x * 0.4 * exp(-dl / (lw * 5.0 + 0.01));

  float rnd = hash21(vec2(idx, 3.7));
  float rv = mix(1.0, rnd, u_misc.y);
  float env = exp(-r2 * u_look.w);

  float a = atan(q.y, q.x);
  float spec1 = pow(0.5 + 0.5 * cos(a - u_look.y), u_look.z);
  float spec2 = pow(0.5 + 0.5 * cos(a - u_look.y - 3.14159265), u_look.z);

  float glint = 1.0 + u_misc.z * energy * atten * (0.5 + 0.5 * sin(phase));

  float line = (core + halo) * rv * env * glint;
  vec3 lightCol = u_colorA.rgb * (spec1 + u_misc.x) + u_colorB.rgb * (spec2 + u_misc.x);
  vec3 col = u_bg.rgb + lightCol * line;

  col += vec3(1.0) * core * rv * env * spec1 * spec1 * 0.35 * glint;

  float n = hash21(uv * res + vec2(fract(t) * 37.0, fract(t * 1.7) * 91.0)) - 0.5;
  col += vec3(n * u_wave.w * 0.08);

  return max(col, vec3(0.0));
}
`
