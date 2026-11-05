// @ts-nocheck
// Copy of the shader module returned by Figma MCP get_design_context for node 1:4
// (shader e325b9a5-7ee9-42b8-a956-f22f2b2dd9e3 "Broadcast interference", version 126caed2…).
// Omitted vs. the export: the `defineProperties(...)` block (a no-op outside Figma) and the unused
// param helpers inside render() (boolParam, selectParam, colorParam, point*Param, gradientParam).
// The WGSL, uniform packing and pass encoding are unchanged.

export default function Effect() { }
export function setup(device, frame) {
    var wgsl = `
diagnostic(off,derivative_uniformity);
struct Uniforms {
  frameData: vec4f,
  inputDimsData: vec4f,
  waveStrength: vec4f,
  waveWidth: vec4f,
  wavePosition: vec4f,
  noiseIntensity: vec4f,
  grainSize: vec4f,
  glitchStrength: vec4f,
  glitchFrequency: vec4f,
  glitchDuration: vec4f,
  scanlineIntensity: vec4f,
  scanlineSpacing: vec4f,
  flickerIntensity: vec4f,
  rgbSeparation: vec4f,
  ghostingStrength: vec4f,
  screenCurvature: vec4f,
  playbackSpeed: vec4f,
  animationPhase: vec4f,
  effectStrength: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var inputTex: texture_2d<f32>;

struct VsIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
};
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

fn sampleInput(p: vec2f) -> vec4f {
  return textureSampleLevel(inputTex, samp, clamp(p, vec2f(0.0), vec2f(1.0)), 0.0);
}

// Like sampleInput but returns transparent (premultiplied zero) outside the
// input rect instead of repeating the edge texel.
fn sampleInputOrZero(p: vec2f) -> vec4f {
  let inside = step(vec2f(0.0), p) * step(p, vec2f(1.0));
  return sampleInput(p) * (inside.x * inside.y);
}

fn hashBroadcast(p: vec2f) -> f32 {

  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);

}

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.position = vec4f(in.pos, 0.0, 1.0);
  out.uv = in.uv;
  return out;
}

@fragment fn fs_main(@location(0) outputUv_in: vec2f) -> @location(0) vec4f {
  let time = u.frameData.x;
  let outputUv = outputUv_in;
  // Distances are in canvas points, independent of rasterization resolution.
  let dims = max(u.frameData.yz / u.frameData.w, vec2f(0.001));
  let inputDims = max(u.inputDimsData.xy, vec2f(1.0));
  let inputTexel = vec2f(1.0) / inputDims;
  let uv = outputUv;
  // texel and aspect are input-relative to match uv. Zoom fills rescale texel
  // alongside their uv redefinition below (see zoomLocal).
  let texel = inputTexel;
  let aspect = inputDims.x / max(inputDims.y, 1.0);
  let waveStrength = u.waveStrength.x;
  let waveWidth = u.waveWidth.x;
  let wavePosition = u.wavePosition.x;
  let noiseIntensity = u.noiseIntensity.x;
  let grainSize = u.grainSize.x;
  let glitchStrength = u.glitchStrength.x;
  let glitchFrequency = u.glitchFrequency.x;
  let glitchDuration = u.glitchDuration.x;
  let scanlineIntensity = u.scanlineIntensity.x;
  let scanlineSpacing = u.scanlineSpacing.x;
  let flickerIntensity = u.flickerIntensity.x;
  let rgbSeparation = u.rgbSeparation.x;
  let ghostingStrength = u.ghostingStrength.x;
  let screenCurvature = u.screenCurvature.x;
  let playbackSpeed = u.playbackSpeed.x;
  let animationPhase = u.animationPhase.x;
  let effectStrength = u.effectStrength.x;
  let inputColor = sampleInput(uv);
  let t = time * playbackSpeed + animationPhase;
  let p = uv * dims;
  let waveCenter = fract(wavePosition / 100.0 + t * 0.16);
  let wrappedY = fract(uv.y - waveCenter + 0.5) - 0.5;
  let envelope = exp(-pow(wrappedY / max(waveWidth * 0.005, 0.01), 2.0) * 2.0);
  let waveShift = waveStrength * envelope * (0.65 * sin(wrappedY * 36.0 + t * 2.0) + 0.35 * sin(uv.y * 60.0 - t * 5.0));
  let cycle = t * max(glitchFrequency, 0.0001);
  let eventId = floor(cycle);
  let eventAge = fract(cycle) / max(glitchFrequency, 0.0001);
  let eventRandom = hashBroadcast(vec2f(eventId, 7.3));
  let eventOn = select(0.0, 1.0, glitchFrequency > 0.0 && eventAge < min(glitchDuration, 0.85 / max(glitchFrequency, 0.0001)));
  let bandCenter = hashBroadcast(vec2f(eventId, 91.0));
  let bandWidth = 0.04 + eventRandom * 0.2;
  let tearBand = 1.0 - smoothstep(bandWidth, bandWidth + 0.018, abs(uv.y - bandCenter));
  let slice = floor(uv.y * 35.0);
  let jitter = hashBroadcast(vec2f(slice + eventId * 71.0, floor(t * 24.0)));
  let tear = glitchStrength * eventOn * tearBand * (jitter * 2.0 - 1.0);
  let centered = uv * 2.0 - 1.0;
  let curved = uv + centered * vec2f(centered.y * centered.y, centered.x * centered.x) * screenCurvature * 0.12;
  let sourceUv = curved + vec2f((waveShift + tear) / dims.x, 0.0);
  let split = rgbSeparation * (1.0 + eventOn * tearBand * 2.0) / dims.x;
  let base = sampleInputOrZero(sourceUv);
  let red = sampleInputOrZero(sourceUv + vec2f(split, 0.0));
  let blue = sampleInputOrZero(sourceUv - vec2f(split, 0.0));
  let ghost = sampleInputOrZero(sourceUv - vec2f((6.0 + waveStrength * 0.2) / dims.x, 0.0));
  // Channel-specific coverage preserves fringe color on transparent lettering.
  let fringeAlpha = max(base.a, max(red.a, blue.a));
  let separated = vec4f(red.r, base.g, blue.b, fringeAlpha);
  var signal = mix(separated, ghost, ghostingStrength);
  let tick = floor(t * 30.0);
  let grain = hashBroadcast(floor(p / max(grainSize, 0.5)) + vec2f(tick * 19.0, tick * 7.0));
  let linePhase = p.y / max(scanlineSpacing, 1.0) + t * 0.7;
  let lineContrast = 0.5 + 0.5 * cos(linePhase * 6.2831853);
  let lineVisibility = 1.0 - smoothstep(0.35, 0.8, fwidth(linePhase));
  let scan = 1.0 - scanlineIntensity * lineContrast * lineVisibility;
  let flicker = 1.0 - flickerIntensity * (0.35 + 0.35 * sin(t * 43.0) + 0.3 * hashBroadcast(vec2f(floor(t * 19.0), 4.0)));
  let cameraGain = max(0.0, (1.0 + (grain - 0.5) * noiseIntensity * 1.8) * scan * flicker);
  let speckle = (grain - 0.5) * noiseIntensity * 0.18 * signal.a;
  signal = vec4f(clamp(signal.rgb * cameraGain + vec3f(speckle), vec3f(0.0), vec3f(signal.a)), signal.a);
  return mix(inputColor, signal, effectStrength);
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
    frame.state.uniformBuf = device.createBuffer({
        size: 304,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    frame.state.sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
    });
    frame.state.placeholder = device.createTexture({
        size: [1, 1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: frame.state.placeholder }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, { width: 1, height: 1, depthOrArrayLayers: 1 });
}
export function render(device, frame) {
    var params = frame.params || {};
    function finiteNumber(value, fallback) {
        var num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }
    function numberParam(name, fallback) {
        return finiteNumber(params[name], fallback);
    }
    var output = frame.output || {};
    var width = Math.max(1, finiteNumber(output.physicalWidth || output.width, 1));
    var height = Math.max(1, finiteNumber(output.physicalHeight || output.height, 1));
    var renderScale = Math.max(0.001, finiteNumber(frame.renderScale, 1));
    var time = finiteNumber(frame.time, 0) * 0.001;
    var inputWidth = width;
    var inputHeight = height;
    device.queue.writeBuffer(frame.state.uniformBuf, 0, new Float32Array([
        time, width, height, renderScale,
        inputWidth, inputHeight, 0, 0,
        numberParam("waveStrength", 12), 0, 0, 0,
        numberParam("waveWidth", 24), 0, 0, 0,
        numberParam("wavePosition", 28), 0, 0, 0,
        numberParam("noiseIntensity", 0.19), 0, 0, 0,
        numberParam("grainSize", 1.2), 0, 0, 0,
        numberParam("glitchStrength", 30), 0, 0, 0,
        numberParam("glitchFrequency", 0.45), 0, 0, 0,
        numberParam("glitchDuration", 0.16), 0, 0, 0,
        numberParam("scanlineIntensity", 0.22), 0, 0, 0,
        numberParam("scanlineSpacing", 3), 0, 0, 0,
        numberParam("flickerIntensity", 0.1), 0, 0, 0,
        numberParam("rgbSeparation", 1.5), 0, 0, 0,
        numberParam("ghostingStrength", 0.15), 0, 0, 0,
        numberParam("screenCurvature", 0.035), 0, 0, 0,
        numberParam("playbackSpeed", 1), 0, 0, 0,
        numberParam("animationPhase", 0), 0, 0, 0,
        numberParam("effectStrength", 0.85), 0, 0, 0,
    ]));
    var inputView = frame.input != null
        ? frame.input.createView()
        : frame.state.placeholder.createView();
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
    var bindGroup = device.createBindGroup({
        layout: frame.state.pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: frame.state.uniformBuf } },
            { binding: 1, resource: frame.state.sampler },
            { binding: 2, resource: inputView },
        ],
    });
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
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, frame.state.quad);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
}

export const manifest = {
  "version": 3,
  "name": "Broadcast interference",
  "isAnimated": true,
  "usesMouse": false,
  "renderScaleAware": true
}
