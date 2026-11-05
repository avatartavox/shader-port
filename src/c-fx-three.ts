// Option C (effects) — Three.js: same GLSL as B, but passes/targets are Three objects
// (ShaderMaterial + WebGLRenderTarget + FullScreenQuad). Shape you'd use inside R3F or an existing scene.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import {
  BLUR_FRAG, BLUR_SCHEDULE, BROADCAST_FRAG, BROADCAST_UNIFORMS, COMPOSITE_FRAG, EXTRACT_FRAG,
  FRAG_HEADER_THREE, VERT_THREE, bloomDerived,
} from './fx-glsl'
import { BLOOM, BROADCAST, FX_SIZE, RENDER_SCALE } from './fx-shared'
import type { Backend } from './shared'

export function createThreeFx(canvas: HTMLCanvasElement, title: HTMLCanvasElement): Backend {
  const fail = (note: string): Backend => ({ id: 'C-fx', canvas, ok: false, note, render() {}, dispose() {} })

  const { w, h } = FX_SIZE
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
  } catch (e) {
    return fail(`Three.js: ${(e as Error).message}`)
  }
  renderer.setPixelRatio(1)
  renderer.setSize(w, h, false)
  renderer.setClearColor(0x000000, 0)

  const material = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      vertexShader: VERT_THREE,
      fragmentShader: FRAG_HEADER_THREE + frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    })

  const makeRT = (rw: number, rh: number) =>
    new THREE.WebGLRenderTarget(Math.max(1, rw), Math.max(1, rh), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
    })
  const rts = {
    mid: makeRT(w, h),
    extract: makeRT(w, h),
    half0: makeRT(Math.floor(w / 2), Math.floor(h / 2)),
    half1: makeRT(Math.floor(w / 2), Math.floor(h / 2)),
    quarter0: makeRT(Math.floor(w / 4), Math.floor(h / 4)),
    quarter1: makeRT(Math.floor(w / 4), Math.floor(h / 4)),
  }

  // Title raster: premultiplied, no flipY (see fx-glsl.ts for the orientation rule).
  const titleTex = new THREE.CanvasTexture(title)
  titleTex.flipY = false
  titleTex.premultiplyAlpha = true
  titleTex.generateMipmaps = false
  titleTex.minFilter = THREE.LinearFilter
  titleTex.magFilter = THREE.LinearFilter
  titleTex.colorSpace = THREE.NoColorSpace
  titleTex.needsUpdate = true

  const d = bloomDerived(BLOOM)

  const broadcastU: Record<string, THREE.IUniform> = {
    u_input: { value: titleTex },
    u_frame: { value: new THREE.Vector4(0, w, h, RENDER_SCALE) },
  }
  for (const n of BROADCAST_UNIFORMS) broadcastU[`u_${n}`] = { value: BROADCAST[n] }
  const broadcastM = material(BROADCAST_FRAG, broadcastU)

  const extractU: Record<string, THREE.IUniform> = {
    u_tex: { value: rts.mid.texture },
    u_res: { value: new THREE.Vector2(w, h) },
    u_threshold: { value: d.threshold },
    u_knee: { value: d.knee },
    u_origin: { value: new THREE.Vector2(d.origin[0], d.origin[1]) },
    u_originRadius: { value: d.originRadius },
    u_aspect: { value: w / h },
  }
  const extractM = material(EXTRACT_FRAG, extractU)

  const blurU: Record<string, THREE.IUniform> = {
    u_tex: { value: rts.extract.texture },
    u_res: { value: new THREE.Vector2(w, h) },
    u_radius: { value: d.radius },
    u_dir: { value: new THREE.Vector2(1, 0) },
    u_renderScale: { value: RENDER_SCALE },
  }
  const blurM = material(BLUR_FRAG, blurU)

  const compositeU: Record<string, THREE.IUniform> = {
    u_original: { value: rts.mid.texture },
    u_half: { value: rts.half0.texture },
    u_quarter: { value: rts.quarter0.texture },
    u_res: { value: new THREE.Vector2(w, h) },
    u_flip: { value: 1 },
    u_intensity: { value: d.intensity },
    u_tint: { value: new THREE.Vector3(BLOOM.tint.r, BLOOM.tint.g, BLOOM.tint.b) },
    u_tintA: { value: BLOOM.tint.a },
    u_vigStr: { value: BLOOM.vignetteStrength / 100 },
    u_vigSoft: { value: BLOOM.vignetteSoftness / 100 },
  }
  const compositeM = material(COMPOSITE_FRAG, compositeU)

  const quad = new FullScreenQuad()
  const run = (m: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
    renderer.setRenderTarget(to)
    quad.material = m
    quad.render(renderer)
  }

  return {
    id: 'C-fx',
    canvas,
    ok: true,
    note: `Three.js r${THREE.REVISION} · ShaderMaterial + WebGLRenderTarget`,
    render(t: number) {
      ;(broadcastU.u_frame.value as THREE.Vector4).x = t * 0.001
      for (const n of BROADCAST_UNIFORMS) broadcastU[`u_${n}`].value = BROADCAST[n]
      run(broadcastM, rts.mid)
      run(extractM, rts.extract)
      for (const s of BLUR_SCHEDULE) {
        const dst = rts[s.dst]
        const src = s.src === 'extract' ? rts.extract : rts[s.src]
        blurU.u_tex.value = src.texture
        ;(blurU.u_res.value as THREE.Vector2).set(dst.width, dst.height)
        blurU.u_radius.value = d.radius / s.div
        ;(blurU.u_dir.value as THREE.Vector2).set(s.dir[0], s.dir[1])
        run(blurM, dst)
      }
      run(compositeM, null)
    },
    dispose() {
      quad.dispose()
      for (const m of [broadcastM, extractM, blurM, compositeM]) m.dispose()
      for (const r of Object.values(rts)) r.dispose()
      titleTex.dispose()
      renderer.dispose()
    },
  }
}
