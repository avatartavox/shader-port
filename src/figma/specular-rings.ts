// @ts-nocheck
// VERBATIM copy of the shader module returned by Figma MCP get_design_context
// (shader 634370ab-bcd8-45cc-b013-40ddbece5cc3, version 8b645d2eb0397a41916826ff96ec0c8a19318fc4).
// Do not edit: it is the source of truth that options B and C are compared against.

// Property metadata is only used in Figma Design, so this is a no-op.
function defineProperties(
  _component: unknown,
  _properties: unknown,
): void {}

export default function Effect() { }
export function setup(device, frame) {
    var wgsl = `diagnostic(off,derivative_uniformity);
struct Uniforms {
  colorA: vec4f,
  colorB: vec4f,
  bg: vec4f,
  view: vec4f,   // aspect, width, height, time(s)
  ring: vec4f,   // centerX, centerY (aspect space), density, lineWidth
  look: vec4f,   // glow, lightAngle(rad), specPower, ringFade
  mouse: vec4f,  // mouseX, mouseY (aspect space), energy, rippleAmp
  wave: vec4f,   // rippleFreq, rippleSpeed, rippleFalloff, grain
  misc: vec4f,   // ambient, variation, rippleGlow, drift
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
};
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.position = vec4f(in.pos, 0.0, 1.0);
  out.uv = in.uv;
  return out;
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = u.view.x;
  let res = u.view.yz;
  let t = u.view.w;
  let p = (uv - vec2f(0.5)) * vec2f(aspect, 1.0);

  let q = p - u.ring.xy;
  let r = length(q);

  // Mouse ripple: waves travel outward from the pointer and push the ring radius.
  let dm = length(p - u.mouse.xy);
  let phase = dm * u.wave.x - t * u.wave.y;
  let atten = exp(-dm * u.wave.z);
  let energy = u.mouse.z;
  let disp = u.mouse.w * energy * atten * sin(phase);
  let r2 = r + disp;

  // Concentric lines, slowly drifting.
  let s = r2 * u.ring.z - t * u.misc.w;
  let idx = floor(s);
  let dl = abs(fract(s) - 0.5);
  let lw = max(u.ring.w, 0.002);
  let core = exp(-pow(dl / lw, 2.0));
  let halo = u.look.x * 0.4 * exp(-dl / (lw * 5.0 + 0.01));

  // Per-ring brightness variation and radial fade.
  let rnd = hash21(vec2f(idx, 3.7));
  let rv = mix(1.0, rnd, u.misc.y);
  let env = exp(-r2 * u.look.w);

  // Two opposed specular lobes: light A and light B.
  let a = atan2(q.y, q.x);
  let spec1 = pow(0.5 + 0.5 * cos(a - u.look.y), u.look.z);
  let spec2 = pow(0.5 + 0.5 * cos(a - u.look.y - 3.14159265), u.look.z);

  // Ripple glint: lines flash as the wave crests pass.
  let glint = 1.0 + u.misc.z * energy * atten * (0.5 + 0.5 * sin(phase));

  let line = (core + halo) * rv * env * glint;
  let lightCol = u.colorA.rgb * (spec1 + u.misc.x) + u.colorB.rgb * (spec2 + u.misc.x);
  var col = u.bg.rgb + lightCol * line;

  // White-hot specular core where light A is strongest.
  col += vec3f(1.0) * core * rv * env * spec1 * spec1 * 0.35 * glint;

  // Film grain.
  let n = hash21(uv * res + vec2f(fract(t) * 37.0, fract(t * 1.7) * 91.0)) - 0.5;
  col += vec3f(n * u.wave.w * 0.08);

  col = max(col, vec3f(0.0));
  return vec4f(col, 1.0);
}
`;
    frame.state.module = device.createShaderModule({ code: wgsl });
    frame.state.pipeline = null;
    frame.state.pipelineFormat = null;
    frame.state.quad = device.createBuffer({
        size: 6 * 4 * 4,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true,
    });
    new Float32Array(frame.state.quad.getMappedRange()).set([
        -1, -1, 0, 1,
        1, -1, 1, 1,
        -1, 1, 0, 0,
        -1, 1, 0, 0,
        1, -1, 1, 1,
        1, 1, 1, 0,
    ]);
    frame.state.quad.unmap();
    frame.state.uniforms = device.createBuffer({
        size: 144,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    frame.state.energy = 0;
    frame.state.prevX = null;
    frame.state.prevY = null;
}
export function render(device, frame) {
    var params = frame.params || {};
    function num(value, fallback) {
        var v = Number(value);
        return Number.isFinite(v) ? v : fallback;
    }
    function channel(color, key, fallback) {
        return num(color ? color[key] : undefined, fallback);
    }
    var w = Math.max(1, frame.output.width);
    var h = Math.max(1, frame.output.height);
    var aspect = w / h;
    var t = num(frame.time, 0) * 0.001;
    var dt = Math.min(0.5, Math.max(0, num(frame.deltaTime, 16) * 0.001));
    var cxUV = num(params.centerX, 55) / 100;
    var cyUV = num(params.centerY, 45) / 100;
    var cx = (cxUV - 0.5) * aspect;
    var cy = cyUV - 0.5;
    // Mouse position in layer pixels; fall back to the ring center when absent.
    var mp = frame.mousePosition;
    var mx = mp && Number.isFinite(Number(mp.x)) ? Number(mp.x) : cxUV * w;
    var my = mp && Number.isFinite(Number(mp.y)) ? Number(mp.y) : cyUV * h;
    // Ripple energy follows pointer speed and decays over time.
    var energy = num(frame.state.energy, 0);
    if (frame.state.prevX == null) {
        frame.state.prevX = mx;
        frame.state.prevY = my;
    }
    var dx = mx - frame.state.prevX;
    var dy = my - frame.state.prevY;
    var speed = Math.sqrt(dx * dx + dy * dy) / h;
    frame.state.prevX = mx;
    frame.state.prevY = my;
    energy = energy * Math.exp(-dt * num(params.rippleDecay, 2)) + speed * 6 * num(params.sensitivity, 1.5);
    energy = Math.min(1, energy);
    frame.state.energy = energy;
    var shownEnergy = Math.max(energy, num(params.idleRipple, 0.1));
    var mxA = (mx / w - 0.5) * aspect;
    var myA = my / h - 0.5;
    var A = params.lightA;
    var B = params.lightB;
    var BG = params.background;
    var angle = num(params.lightAngle, -20) * Math.PI / 180;
    device.queue.writeBuffer(frame.state.uniforms, 0, new Float32Array([
        channel(A, 'r', 0.1), channel(A, 'g', 0.3), channel(A, 'b', 1.0), 1,
        channel(B, 'r', 0.25), channel(B, 'g', 0.85), channel(B, 'b', 1.0), 1,
        channel(BG, 'r', 0.0), channel(BG, 'g', 0.0), channel(BG, 'b', 0.01), 1,
        aspect, w, h, t,
        cx, cy, num(params.ringCount, 6), num(params.lineWidth, 0.025),
        num(params.glow, 0.8), angle, num(params.specPower, 8), num(params.ringFade, 0.4),
        mxA, myA, shownEnergy, num(params.rippleAmp, 0.04),
        num(params.rippleFreq, 30), num(params.rippleSpeed, 6), num(params.rippleFalloff, 2.5), num(params.grain, 0.5),
        num(params.ambient, 0.05), num(params.variation, 0.5), num(params.rippleGlow, 1), num(params.drift, 0.15),
    ]));
    var outputFormat = frame.output.format;
    if (frame.state.pipeline == null || frame.state.pipelineFormat !== outputFormat) {
        frame.state.pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: frame.state.module,
                entryPoint: 'vs_main',
                buffers: [{
                        arrayStride: 16,
                        attributes: [
                            { shaderLocation: 0, format: 'float32x2', offset: 0 },
                            { shaderLocation: 1, format: 'float32x2', offset: 8 },
                        ],
                    }],
            },
            fragment: {
                module: frame.state.module,
                entryPoint: 'fs_main',
                targets: [{ format: outputFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });
        frame.state.pipelineFormat = outputFormat;
    }
    var encoder = device.createCommandEncoder();
    var pass = encoder.beginRenderPass({
        colorAttachments: [{
                view: frame.output.createView(),
                loadOp: 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: 'store',
            }],
    });
    pass.setPipeline(frame.state.pipeline);
    var bindGroup = device.createBindGroup({
        layout: frame.state.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: frame.state.uniforms } }],
    });
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, frame.state.quad);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
}
defineProperties(Effect, {
    lightA: { type: 'color', label: 'Light A', defaultValue: { r: 0.1, g: 0.3, b: 1.0, a: 1 } },
    lightB: { type: 'color', label: 'Light B', defaultValue: { r: 0.25, g: 0.85, b: 1.0, a: 1 } },
    background: { type: 'color', label: 'Background', defaultValue: { r: 0.0, g: 0.0, b: 0.01, a: 1 } },
    centerX: { type: 'number', label: 'Center X', defaultValue: 55, min: -50, max: 150, step: 1, control: 'slider', unit: '%' },
    centerY: { type: 'number', label: 'Center Y', defaultValue: 45, min: -50, max: 150, step: 1, control: 'slider', unit: '%' },
    ringCount: { type: 'number', label: 'Ring density', defaultValue: 6, min: 1, max: 40, step: 0.5, control: 'slider' },
    lineWidth: { type: 'number', label: 'Line width', defaultValue: 0.025, min: 0.005, max: 0.3, step: 0.005, control: 'slider' },
    glow: { type: 'number', label: 'Glow', defaultValue: 0.8, min: 0, max: 2, step: 0.05, control: 'slider' },
    lightAngle: { type: 'number', label: 'Light angle', defaultValue: -20, min: -180, max: 180, step: 1, control: 'slider', unit: '°' },
    specPower: { type: 'number', label: 'Specular focus', defaultValue: 8, min: 1, max: 30, step: 0.5, control: 'slider' },
    ambient: { type: 'number', label: 'Ambient', defaultValue: 0.05, min: 0, max: 0.5, step: 0.01, control: 'slider' },
    ringFade: { type: 'number', label: 'Radial fade', defaultValue: 0.4, min: 0, max: 3, step: 0.05, control: 'slider' },
    variation: { type: 'number', label: 'Ring variation', defaultValue: 0.5, min: 0, max: 1, step: 0.05, control: 'slider' },
    drift: { type: 'number', label: 'Drift speed', defaultValue: 0.15, min: -2, max: 2, step: 0.05, control: 'slider' },
    rippleAmp: { type: 'number', label: 'Ripple strength', defaultValue: 0.04, min: 0, max: 0.2, step: 0.005, control: 'slider' },
    rippleFreq: { type: 'number', label: 'Ripple frequency', defaultValue: 30, min: 5, max: 80, step: 1, control: 'slider' },
    rippleSpeed: { type: 'number', label: 'Ripple speed', defaultValue: 6, min: 0, max: 20, step: 0.5, control: 'slider' },
    rippleFalloff: { type: 'number', label: 'Ripple falloff', defaultValue: 2.5, min: 0, max: 8, step: 0.1, control: 'slider' },
    rippleGlow: { type: 'number', label: 'Ripple glint', defaultValue: 1, min: 0, max: 3, step: 0.05, control: 'slider' },
    sensitivity: { type: 'number', label: 'Mouse sensitivity', defaultValue: 1.5, min: 0.2, max: 4, step: 0.1, control: 'slider' },
    rippleDecay: { type: 'number', label: 'Ripple decay', defaultValue: 2, min: 0.5, max: 6, step: 0.1, control: 'slider' },
    idleRipple: { type: 'number', label: 'Idle ripple', defaultValue: 0.1, min: 0, max: 1, step: 0.05, control: 'slider' },
    grain: { type: 'number', label: 'Grain', defaultValue: 0.5, min: 0, max: 1, step: 0.05, control: 'slider' },
});

export const manifest = {
  "isAnimated": true,
  "name": "Specular rings + mouse ripple",
  "usesMouse": true,
  "version": 2
}
