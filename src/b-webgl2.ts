// Option B — hand port of the WGSL to GLSL ES 3.00, plain WebGL2, zero dependencies.
import { GLSL_SHADE, GLSL_UNIFORMS, PARAMS, RippleState, UNIFORM_NAMES, packUniforms, type Backend, type Pointer } from './shared'

const VERT = `#version 300 es
void main() {
  // Full-screen triangle, no vertex buffers.
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
${GLSL_UNIFORMS}
${GLSL_SHADE}
out vec4 outColor;
void main() {
  outColor = vec4(shade(gl_FragCoord.xy), 1.0);
}`

export function createWebGL2(canvas: HTMLCanvasElement): Backend {
  const fail = (note: string): Backend => ({ id: 'B', canvas, ok: false, note, render() {}, dispose() {} })

  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })
  if (!gl) return fail('WebGL2 no disponible')

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile error')
    return s
  }

  let program: WebGLProgram
  try {
    program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error')
  } catch (e) {
    return fail(`GLSL: ${(e as Error).message}`)
  }

  gl.useProgram(program)
  const locs = UNIFORM_NAMES.map((n) => gl.getUniformLocation(program, `u_${n}`))
  const ripple = new RippleState()

  return {
    id: 'B',
    canvas,
    ok: true,
    note: 'WebGL2 · GLSL ES 3.00 · sin dependencias',
    render(t: number, dt: number, pointer: Pointer) {
      const w = canvas.width
      const h = canvas.height
      const data = packUniforms(w, h, t, dt, pointer, ripple, PARAMS)
      for (let i = 0; i < locs.length; i++) gl.uniform4fv(locs[i], data.subarray(i * 4, i * 4 + 4))
      gl.viewport(0, 0, w, h)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteProgram(program)
    },
  }
}
