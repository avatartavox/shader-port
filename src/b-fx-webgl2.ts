// Option B (effects) — raw WebGL2: same chain as A, written out by hand (programs, FBOs, passes).
import {
  BLUR_FRAG, BLUR_SCHEDULE, BROADCAST_FRAG, BROADCAST_UNIFORMS, COMPOSITE_FRAG, EXTRACT_FRAG,
  FRAG_HEADER_RAW, VERT_RAW, bloomDerived,
} from './fx-glsl'
import { BLOOM, BROADCAST, FX_SIZE, RENDER_SCALE } from './fx-shared'
import type { Backend } from './shared'

type RT = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

export function createWebGL2Fx(canvas: HTMLCanvasElement, title: HTMLCanvasElement): Backend {
  const fail = (note: string): Backend => ({ id: 'B-fx', canvas, ok: false, note, render() {}, dispose() {} })

  canvas.width = FX_SIZE.w
  canvas.height = FX_SIZE.h
  // alpha + premultipliedAlpha so the effect composites over the fill canvas below.
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
  if (!gl) return fail('WebGL2 no disponible')

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile error')
    return s
  }
  const program = (frag: string) => {
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT_RAW))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG_HEADER_RAW + frag))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
    const locs = new Map<string, WebGLUniformLocation | null>()
    const loc = (n: string) => {
      if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n))
      return locs.get(n)!
    }
    return { p, loc }
  }

  let broadcastP: ReturnType<typeof program>
  let extractP: ReturnType<typeof program>
  let blurP: ReturnType<typeof program>
  let compositeP: ReturnType<typeof program>
  try {
    broadcastP = program(BROADCAST_FRAG)
    extractP = program(EXTRACT_FRAG)
    blurP = program(BLUR_FRAG)
    compositeP = program(COMPOSITE_FRAG)
  } catch (e) {
    return fail(`GLSL: ${(e as Error).message}`)
  }

  const makeTex = (w: number, h: number) => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }
  const makeRT = (w: number, h: number): RT => {
    const tex = makeTex(w, h)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return { tex, fbo, w, h }
  }

  const { w, h } = FX_SIZE
  const rts = {
    mid: makeRT(w, h),
    extract: makeRT(w, h),
    half0: makeRT(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2))),
    half1: makeRT(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2))),
    quarter0: makeRT(Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4))),
    quarter1: makeRT(Math.max(1, Math.floor(w / 4)), Math.max(1, Math.floor(h / 4))),
  }

  // Title raster -> texture. Premultiplied, no Y flip (see fx-glsl.ts for the orientation rule).
  const titleTex = makeTex(w, h)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.bindTexture(gl.TEXTURE_2D, titleTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, title)

  const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }
  const target = (rt: RT | null, tw: number, th: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fbo : null)
    gl.viewport(0, 0, tw, th)
  }
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3)

  const d = bloomDerived(BLOOM)
  gl.disable(gl.BLEND)

  return {
    id: 'B-fx',
    canvas,
    ok: true,
    note: 'WebGL2 · 4 programas GLSL + 6 render targets a mano',
    render(t: number) {
      // 1) Broadcast interference: title -> mid
      gl.useProgram(broadcastP.p)
      target(rts.mid, w, h)
      bind(0, titleTex, broadcastP.loc('u_input'))
      gl.uniform4f(broadcastP.loc('u_frame'), t * 0.001, w, h, RENDER_SCALE)
      for (const n of BROADCAST_UNIFORMS) gl.uniform1f(broadcastP.loc(`u_${n}`), BROADCAST[n])
      draw()

      // 2) Bloom: extract bright areas of `mid`
      gl.useProgram(extractP.p)
      target(rts.extract, w, h)
      bind(0, rts.mid.tex, extractP.loc('u_tex'))
      gl.uniform2f(extractP.loc('u_res'), w, h)
      gl.uniform1f(extractP.loc('u_threshold'), d.threshold)
      gl.uniform1f(extractP.loc('u_knee'), d.knee)
      gl.uniform2f(extractP.loc('u_origin'), d.origin[0], d.origin[1])
      gl.uniform1f(extractP.loc('u_originRadius'), d.originRadius)
      gl.uniform1f(extractP.loc('u_aspect'), w / h)
      draw()

      // 3) Six blur passes at half / quarter resolution
      gl.useProgram(blurP.p)
      for (const s of BLUR_SCHEDULE) {
        const dst = rts[s.dst]
        const src = s.src === 'extract' ? rts.extract : rts[s.src]
        target(dst, dst.w, dst.h)
        bind(0, src.tex, blurP.loc('u_tex'))
        gl.uniform2f(blurP.loc('u_res'), dst.w, dst.h)
        gl.uniform1f(blurP.loc('u_radius'), d.radius / s.div)
        gl.uniform2f(blurP.loc('u_dir'), s.dir[0], s.dir[1])
        gl.uniform1f(blurP.loc('u_renderScale'), RENDER_SCALE)
        draw()
      }

      // 4) Composite to the visible canvas (flip Y once, here)
      gl.useProgram(compositeP.p)
      target(null, w, h)
      bind(0, rts.mid.tex, compositeP.loc('u_original'))
      bind(1, rts.half0.tex, compositeP.loc('u_half'))
      bind(2, rts.quarter0.tex, compositeP.loc('u_quarter'))
      gl.uniform2f(compositeP.loc('u_res'), w, h)
      gl.uniform1f(compositeP.loc('u_flip'), 1)
      gl.uniform1f(compositeP.loc('u_intensity'), d.intensity)
      gl.uniform3f(compositeP.loc('u_tint'), BLOOM.tint.r, BLOOM.tint.g, BLOOM.tint.b)
      gl.uniform1f(compositeP.loc('u_tintA'), BLOOM.tint.a)
      gl.uniform1f(compositeP.loc('u_vigStr'), BLOOM.vignetteStrength / 100)
      gl.uniform1f(compositeP.loc('u_vigSoft'), BLOOM.vignetteSoftness / 100)
      draw()
    },
    dispose() {
      for (const x of [broadcastP, extractP, blurP, compositeP]) gl.deleteProgram(x.p)
    },
  }
}
