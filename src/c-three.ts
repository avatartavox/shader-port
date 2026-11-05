// Option C — same GLSL as B, but inside Three.js (ShaderMaterial on a full-screen quad).
// This is the shape you would use inside React Three Fiber / an existing 3D scene.
import * as THREE from 'three'
import { GLSL_SHADE, GLSL_UNIFORMS, PARAMS, RippleState, UNIFORM_NAMES, packUniforms, type Backend, type Pointer } from './shared'

const VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const FRAG = /* glsl */ `
${GLSL_UNIFORMS}
${GLSL_SHADE}
void main() {
  gl_FragColor = vec4(shade(gl_FragCoord.xy), 1.0);
}`

export function createThree(canvas: HTMLCanvasElement): Backend {
  const fail = (note: string): Backend => ({ id: 'C', canvas, ok: false, note, render() {}, dispose() {} })

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })
  } catch (e) {
    return fail(`Three.js: ${(e as Error).message}`)
  }
  renderer.setPixelRatio(1)
  renderer.setSize(canvas.width, canvas.height, false)

  const uniforms: Record<string, THREE.IUniform<THREE.Vector4>> = {}
  for (const n of UNIFORM_NAMES) uniforms[`u_${n}`] = { value: new THREE.Vector4() }

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    depthTest: false,
    depthWrite: false,
  })
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material))
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const ripple = new RippleState()

  return {
    id: 'C',
    canvas,
    ok: true,
    note: `Three.js r${THREE.REVISION} · ShaderMaterial`,
    render(t: number, dt: number, pointer: Pointer) {
      const data = packUniforms(canvas.width, canvas.height, t, dt, pointer, ripple, PARAMS)
      UNIFORM_NAMES.forEach((n, i) => uniforms[`u_${n}`].value.fromArray(data, i * 4))
      renderer.render(scene, camera)
    },
    dispose() {
      material.dispose()
      renderer.dispose()
    },
  }
}
