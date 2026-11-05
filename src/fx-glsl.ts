// GLSL ES 3.00 ports of the two Figma effects, shared by option B (raw WebGL2) and C (Three.js).
//
// Texture-orientation convention used by every OFFSCREEN pass: uv = gl_FragCoord / resolution,
// so uv.y = 0 is the first stored row — the same "image top" the WGSL uses (uv.y = 0 at the top).
// The canvas is uploaded without Y flip, so the chain stays consistent end to end. Only the final
// pass (to the visible canvas) flips Y with `u_flip = 1`.
import { BROADCAST } from './fx-shared'

export const FRAG_HEADER_RAW = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 outColor;
#define FRAG_OUT outColor
`

// Three.js prepends its own version/precision/out declarations for ShaderMaterial.
export const FRAG_HEADER_THREE = `#define FRAG_OUT gl_FragColor
`

export const VERT_RAW = `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

export const VERT_THREE = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`

export const BROADCAST_UNIFORMS = Object.keys(BROADCAST) as (keyof typeof BROADCAST)[]

export const BROADCAST_FRAG = `
uniform sampler2D u_input;
uniform vec4 u_frame; // time(s), width, height (physical px), renderScale
${BROADCAST_UNIFORMS.map((n) => `uniform float u_${n};`).join('\n')}

vec4 sampleInput(vec2 p) {
  return textureLod(u_input, clamp(p, vec2(0.0), vec2(1.0)), 0.0);
}
vec4 sampleInputOrZero(vec2 p) {
  vec2 inside = step(vec2(0.0), p) * step(p, vec2(1.0));
  return sampleInput(p) * (inside.x * inside.y);
}
float hashBroadcast(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float time = u_frame.x;
  vec2 res = u_frame.yz;
  vec2 uv = gl_FragCoord.xy / res;
  vec2 dims = max(res / u_frame.w, vec2(0.001));

  vec4 inputColor = sampleInput(uv);
  float t = time * u_playbackSpeed + u_animationPhase;
  vec2 p = uv * dims;

  float waveCenter = fract(u_wavePosition / 100.0 + t * 0.16);
  float wrappedY = fract(uv.y - waveCenter + 0.5) - 0.5;
  float envelope = exp(-pow(wrappedY / max(u_waveWidth * 0.005, 0.01), 2.0) * 2.0);
  float waveShift = u_waveStrength * envelope * (0.65 * sin(wrappedY * 36.0 + t * 2.0) + 0.35 * sin(uv.y * 60.0 - t * 5.0));

  float cycle = t * max(u_glitchFrequency, 0.0001);
  float eventId = floor(cycle);
  float eventAge = fract(cycle) / max(u_glitchFrequency, 0.0001);
  float eventRandom = hashBroadcast(vec2(eventId, 7.3));
  float eventOn = (u_glitchFrequency > 0.0 && eventAge < min(u_glitchDuration, 0.85 / max(u_glitchFrequency, 0.0001))) ? 1.0 : 0.0;
  float bandCenter = hashBroadcast(vec2(eventId, 91.0));
  float bandWidth = 0.04 + eventRandom * 0.2;
  float tearBand = 1.0 - smoothstep(bandWidth, bandWidth + 0.018, abs(uv.y - bandCenter));
  float slice = floor(uv.y * 35.0);
  float jitter = hashBroadcast(vec2(slice + eventId * 71.0, floor(t * 24.0)));
  float tear = u_glitchStrength * eventOn * tearBand * (jitter * 2.0 - 1.0);

  vec2 centered = uv * 2.0 - 1.0;
  vec2 curved = uv + centered * vec2(centered.y * centered.y, centered.x * centered.x) * u_screenCurvature * 0.12;
  vec2 sourceUv = curved + vec2((waveShift + tear) / dims.x, 0.0);
  float split = u_rgbSeparation * (1.0 + eventOn * tearBand * 2.0) / dims.x;

  vec4 base = sampleInputOrZero(sourceUv);
  vec4 red = sampleInputOrZero(sourceUv + vec2(split, 0.0));
  vec4 blue = sampleInputOrZero(sourceUv - vec2(split, 0.0));
  vec4 ghost = sampleInputOrZero(sourceUv - vec2((6.0 + u_waveStrength * 0.2) / dims.x, 0.0));

  float fringeAlpha = max(base.a, max(red.a, blue.a));
  vec4 separated = vec4(red.r, base.g, blue.b, fringeAlpha);
  vec4 signal = mix(separated, ghost, u_ghostingStrength);

  float tick = floor(t * 30.0);
  float grain = hashBroadcast(floor(p / max(u_grainSize, 0.5)) + vec2(tick * 19.0, tick * 7.0));
  float linePhase = p.y / max(u_scanlineSpacing, 1.0) + t * 0.7;
  float lineContrast = 0.5 + 0.5 * cos(linePhase * 6.2831853);
  float lineVisibility = 1.0 - smoothstep(0.35, 0.8, fwidth(linePhase));
  float scan = 1.0 - u_scanlineIntensity * lineContrast * lineVisibility;
  float flicker = 1.0 - u_flickerIntensity * (0.35 + 0.35 * sin(t * 43.0) + 0.3 * hashBroadcast(vec2(floor(t * 19.0), 4.0)));
  float cameraGain = max(0.0, (1.0 + (grain - 0.5) * u_noiseIntensity * 1.8) * scan * flicker);
  float speckle = (grain - 0.5) * u_noiseIntensity * 0.18 * signal.a;
  signal = vec4(clamp(signal.rgb * cameraGain + vec3(speckle), vec3(0.0), vec3(signal.a)), signal.a);

  FRAG_OUT = mix(inputColor, signal, u_effectStrength);
}
`

export const EXTRACT_FRAG = `
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_threshold;
uniform float u_knee;
uniform vec2 u_origin;
uniform float u_originRadius;
uniform float u_aspect;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec4 color = textureLod(u_tex, uv, 0.0);
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  float bright = smoothstep(u_threshold, u_threshold + u_knee, lum);
  float dx = (uv.x - u_origin.x) * u_aspect;
  float dy = uv.y - u_origin.y;
  float dist = sqrt(dx * dx + dy * dy);
  float mask = 1.0 - smoothstep(u_originRadius * 0.9, u_originRadius, dist);
  FRAG_OUT = vec4(color.rgb * bright * mask, color.a);
}
`

export const BLUR_FRAG = `
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_radius;
uniform vec2 u_dir;
uniform float u_renderScale;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 dims = vec2(textureSize(u_tex, 0));
  float sigma = max(u_radius * 0.5, 0.001);
  float sigmaDenom = 2.0 * sigma * sigma;
  vec2 stepUv = u_dir * u_renderScale / dims;
  vec4 colorSum = vec4(0.0);
  float weightSum = 0.0;
  for (int i = -16; i <= 16; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / sigmaDenom);
    vec2 sampleUv = clamp(uv + stepUv * fi, vec2(0.0), vec2(1.0));
    colorSum += textureLod(u_tex, sampleUv, 0.0) * w;
    weightSum += w;
  }
  FRAG_OUT = colorSum / weightSum;
}
`

export const COMPOSITE_FRAG = `
uniform sampler2D u_original;
uniform sampler2D u_half;
uniform sampler2D u_quarter;
uniform vec2 u_res;
uniform float u_flip;
uniform float u_intensity;
uniform vec3 u_tint;
uniform float u_tintA;
uniform float u_vigStr;
uniform float u_vigSoft;

void main() {
  vec2 frag = gl_FragCoord.xy / u_res;
  vec2 uv = vec2(frag.x, mix(frag.y, 1.0 - frag.y, u_flip));
  vec4 original = textureLod(u_original, uv, 0.0);
  vec4 halfGlow = textureLod(u_half, uv, 0.0);
  vec4 quarterGlow = textureLod(u_quarter, uv, 0.0);

  vec4 glow = halfGlow * 0.6 + quarterGlow * 0.4;
  vec3 tintedGlow = mix(glow.rgb, glow.rgb * u_tint, u_tintA) * u_intensity;
  vec3 composited = clamp(original.rgb + tintedGlow, vec3(0.0), vec3(1.0));

  float power = 1.0 + (1.0 - u_vigSoft) * 4.0;
  float d = pow(length(uv - vec2(0.5)) * 1.41421356, power);
  float vignette = 1.0 - clamp(d * u_vigStr, 0.0, 1.0);

  FRAG_OUT = vec4(composited * vignette, original.a);
}
`

/** The Bloom blur schedule from the Figma module: [source, target, radiusDivisor, dir]. */
export const BLUR_SCHEDULE = [
  { src: 'extract', dst: 'half0', div: 2, dir: [1, 0] },
  { src: 'half0', dst: 'quarter0', div: 4, dir: [1, 0] },
  { src: 'quarter0', dst: 'quarter1', div: 1, dir: [1, 0] },
  { src: 'quarter1', dst: 'quarter0', div: 1, dir: [0, 1] },
  { src: 'half0', dst: 'half1', div: 1, dir: [1, 0] },
  { src: 'half1', dst: 'half0', div: 1, dir: [0, 1] },
] as const

/** Derived Bloom uniforms (same maths as the Figma module's render()). */
export function bloomDerived(p: {
  threshold: number
  intensity: number
  softness: number
  origin: { x: number; y: number; radius: number }
}) {
  return {
    threshold: 0.85 - (p.threshold / 100) * 0.75,
    intensity: (p.intensity / 100) * 3,
    radius: 5 + (p.softness / 100) * 55,
    origin: [p.origin.x / 100, p.origin.y / 100] as const,
    originRadius: p.origin.radius / 100,
    knee: 0.05,
  }
}
