// @ts-nocheck
// Figma's first-party "Bloom" effect (d4c18108-ee0c-455e-bbb4-2daa7af72d86, version 7b2f6dff…),
// read with MCP get_shader and re-published as the user's own shader "Bloom multipass (copy)"
// (cc396ce4-c47d-4f4f-8a69-b523c8cc8444) so it could be applied to the node via the plugin API.
// Differences vs. the original: `frame.renderScale ?? 1` (the copy cannot set renderScaleAware in
// its manifest) and the omitted `defineProperties(...)` block (no-op outside Figma).

export default function Effect() {}

export function setup(device, frame) {
  const vertexWGSL = `
diagnostic(off,derivative_uniformity);

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VsOut {
  var out: VsOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}
`;

  const extractWGSL = `
diagnostic(off,derivative_uniformity);

struct ExtractUniforms {
  threshold: f32,
  knee: f32,
  originX: f32,
  originY: f32,
  originRadius: f32,
  aspectRatio: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> u: ExtractUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var inputTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTex, samp, in.uv, 0.0);
  let lum = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let bright = smoothstep(u.threshold, u.threshold + u.knee, lum);
  let dx = (in.uv.x - u.originX) * u.aspectRatio;
  let dy = in.uv.y - u.originY;
  let dist = sqrt(dx * dx + dy * dy);
  let mask = 1.0 - smoothstep(u.originRadius * 0.9, u.originRadius, dist);
  return vec4f(color.rgb * bright * mask, color.a);
}
`;

  const blurWGSL = `
diagnostic(off,derivative_uniformity);

struct BlurUniforms {
  radius: f32,
  dirX: f32,
  dirY: f32,
  renderScale: f32,
};

@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var inputTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTex, 0));
  let sigma = max(u.radius * 0.5, 0.001);
  let sigmaDenom = 2.0 * sigma * sigma;
  let step = vec2f(u.dirX, u.dirY) * u.renderScale / dims;
  var colorSum = vec4f(0.0);
  var weightSum = 0.0;

  for (var i = -16; i <= 16; i++) {
    let fi = f32(i);
    let w = exp(-fi * fi / sigmaDenom);
    let sampleUv = clamp(
      in.uv + step * fi,
      vec2f(0.0),
      vec2f(1.0),
    );
    colorSum +=
      textureSampleLevel(inputTex, samp, sampleUv, 0.0) * w;
    weightSum += w;
  }

  return colorSum / weightSum;
}
`;

  const compositeWGSL = `
diagnostic(off,derivative_uniformity);

struct CompositeUniforms {
  intensity: f32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  vignetteStrength: f32,
  vignetteSoftness: f32,
  tintA: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> u: CompositeUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var originalTex: texture_2d<f32>;
@group(0) @binding(3) var halfGlowTex: texture_2d<f32>;
@group(0) @binding(4) var quarterGlowTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let original =
    textureSampleLevel(originalTex, samp, in.uv, 0.0);
  let halfGlow =
    textureSampleLevel(halfGlowTex, samp, in.uv, 0.0);
  let quarterGlow =
    textureSampleLevel(quarterGlowTex, samp, in.uv, 0.0);

  let glow = halfGlow * 0.6 + quarterGlow * 0.4;
  let tint = vec3f(u.tintR, u.tintG, u.tintB);
  let tintedGlow =
    mix(glow.rgb, glow.rgb * tint, u.tintA) * u.intensity;
  let composited = clamp(
    original.rgb + tintedGlow,
    vec3f(0.0),
    vec3f(1.0),
  );

  let power =
    1.0 + (1.0 - u.vignetteSoftness) * 4.0;
  let d = pow(
    length(in.uv - vec2f(0.5)) * 1.41421356,
    power,
  );
  let vignette =
    1.0 - clamp(d * u.vignetteStrength, 0.0, 1.0);

  return vec4f(composited * vignette, original.a);
}
`;

  frame.state.vertexModule =
    device.createShaderModule({ code: vertexWGSL });
  frame.state.extractModule =
    device.createShaderModule({ code: extractWGSL });
  frame.state.blurModule =
    device.createShaderModule({ code: blurWGSL });
  frame.state.compositeModule =
    device.createShaderModule({ code: compositeWGSL });

  frame.state.sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  frame.state.vertexBuffers = [{
    arrayStride: 16,
    attributes: [
      {
        shaderLocation: 0,
        format: "float32x2",
        offset: 0,
      },
      {
        shaderLocation: 1,
        format: "float32x2",
        offset: 8,
      },
    ],
  }];

  frame.state.extractPipeline =
    device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: frame.state.vertexModule,
        entryPoint: "vs_main",
        buffers: frame.state.vertexBuffers,
      },
      fragment: {
        module: frame.state.extractModule,
        entryPoint: "fs_main",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });

  frame.state.blurPipeline =
    device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: frame.state.vertexModule,
        entryPoint: "vs_main",
        buffers: frame.state.vertexBuffers,
      },
      fragment: {
        module: frame.state.blurModule,
        entryPoint: "fs_main",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });

  // Extract uniform: 32 bytes
  frame.state.extractUniformBuf = device.createBuffer({
    size: 32,
    usage:
      GPUBufferUsage.UNIFORM |
      GPUBufferUsage.COPY_DST,
  });
  frame.state.extractUniformData = new Float32Array(8);
  frame.state.lastExtractUniformData =
    new Float32Array(8);
  frame.state.lastExtractUniformData.fill(NaN);

  // Blur uniforms: 6 passes, each 16 bytes
  frame.state.blurUniformBufs = [];
  frame.state.blurUniformData = [];
  frame.state.lastBlurUniformData = [];

  for (let i = 0; i < 6; i++) {
    frame.state.blurUniformBufs.push(
      device.createBuffer({
        size: 16,
        usage:
          GPUBufferUsage.UNIFORM |
          GPUBufferUsage.COPY_DST,
      }),
    );

    frame.state.blurUniformData.push(
      new Float32Array(4),
    );

    const lastBlurData = new Float32Array(4);
    lastBlurData.fill(NaN);
    frame.state.lastBlurUniformData.push(
      lastBlurData,
    );
  }

  frame.state.blurUniformData[0][1] = 1.0;
  frame.state.blurUniformData[1][1] = 1.0;
  frame.state.blurUniformData[2][1] = 1.0;
  frame.state.blurUniformData[3][2] = 1.0;
  frame.state.blurUniformData[4][1] = 1.0;
  frame.state.blurUniformData[5][2] = 1.0;

  // Composite uniform: 32 bytes
  frame.state.compositeUniformBuf =
    device.createBuffer({
      size: 32,
      usage:
        GPUBufferUsage.UNIFORM |
        GPUBufferUsage.COPY_DST,
    });
  frame.state.compositeUniformData =
    new Float32Array(8);
  frame.state.lastCompositeUniformData =
    new Float32Array(8);
  frame.state.lastCompositeUniformData.fill(NaN);

  // Fullscreen quad
  frame.state.quad = device.createBuffer({
    size: 6 * 4 * 4,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });

  new Float32Array(
    frame.state.quad.getMappedRange(),
  ).set([
    -1, -1, 0, 1,
     1, -1, 1, 1,
    -1,  1, 0, 0,
    -1,  1, 0, 0,
     1, -1, 1, 1,
     1,  1, 1, 0,
  ]);

  frame.state.quad.unmap();

  frame.state.lastWidth = 0;
  frame.state.lastHeight = 0;
  frame.state.pipelineFormat = null;

  frame.state.inputTexture = null;
  frame.state.inputView = null;
  frame.state.extractBindGroup = null;

  frame.state.outputTexture = null;
  frame.state.outputView = null;

  frame.state.compositeBindGroup = null;
}

function makeTexture(device, width, height) {
  return device.createTexture({
    size: [width, height, 1],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING,
  });
}

function writeUniformIfChanged(
  device,
  buffer,
  data,
  lastData,
) {
  let changed = false;

  for (let i = 0; i < data.length; i++) {
    if (data[i] !== lastData[i]) {
      changed = true;
      break;
    }
  }

  if (changed) {
    device.queue.writeBuffer(buffer, 0, data);
    lastData.set(data);
  }
}

export function render(device, frame) {
  if (frame.input == null) return;

  const p = frame.params;
  const threshold =
    0.85 - (p.threshold / 100.0) * 0.75;
  const intensity =
    (p.intensity / 100.0) * 3.0;
  const radius =
    5.0 + (p.softness / 100.0) * 55.0;

  const originX = p.origin.x / 100.0;
  const originY = p.origin.y / 100.0;
  const originRadius = p.origin.radius / 100.0;

  const inW = frame.input.physicalWidth ?? frame.input.width;
  const inH = frame.input.physicalHeight ?? frame.input.height;
  const halfW = Math.max(
    1,
    Math.floor(inW / 2),
  );
  const halfH = Math.max(
    1,
    Math.floor(inH / 2),
  );
  const quarterW = Math.max(
    1,
    Math.floor(inW / 4),
  );
  const quarterH = Math.max(
    1,
    Math.floor(inH / 4),
  );

  if (
    frame.state.lastWidth !== inW ||
    frame.state.lastHeight !== inH
  ) {
    if (frame.state.extractTex) {
      frame.state.extractTex.destroy();
    }
    if (frame.state.half0Tex) {
      frame.state.half0Tex.destroy();
    }
    if (frame.state.half1Tex) {
      frame.state.half1Tex.destroy();
    }
    if (frame.state.quarter0Tex) {
      frame.state.quarter0Tex.destroy();
    }
    if (frame.state.quarter1Tex) {
      frame.state.quarter1Tex.destroy();
    }

    frame.state.extractTex =
      makeTexture(device, inW, inH);
    frame.state.half0Tex =
      makeTexture(device, halfW, halfH);
    frame.state.half1Tex =
      makeTexture(device, halfW, halfH);
    frame.state.quarter0Tex =
      makeTexture(device, quarterW, quarterH);
    frame.state.quarter1Tex =
      makeTexture(device, quarterW, quarterH);

    frame.state.extractView =
      frame.state.extractTex.createView();
    frame.state.half0View =
      frame.state.half0Tex.createView();
    frame.state.half1View =
      frame.state.half1Tex.createView();
    frame.state.quarter0View =
      frame.state.quarter0Tex.createView();
    frame.state.quarter1View =
      frame.state.quarter1Tex.createView();

    const blurSources = [
      frame.state.extractView,
      frame.state.half0View,
      frame.state.quarter0View,
      frame.state.quarter1View,
      frame.state.half0View,
      frame.state.half1View,
    ];

    frame.state.blurTargetViews = [
      frame.state.half0View,
      frame.state.quarter0View,
      frame.state.quarter1View,
      frame.state.quarter0View,
      frame.state.half1View,
      frame.state.half0View,
    ];

    frame.state.blurBindGroups = [];

    for (
      let blurIndex = 0;
      blurIndex < 6;
      blurIndex++
    ) {
      frame.state.blurBindGroups.push(
        device.createBindGroup({
          layout:
            frame.state.blurPipeline
              .getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer:
                  frame.state
                    .blurUniformBufs[blurIndex],
              },
            },
            {
              binding: 1,
              resource: frame.state.sampler,
            },
            {
              binding: 2,
              resource: blurSources[blurIndex],
            },
          ],
        }),
      );
    }

    // References resized intermediate textures.
    frame.state.compositeBindGroup = null;

    frame.state.lastWidth = inW;
    frame.state.lastHeight = inH;
  }

  if (
    frame.state.pipelineFormat !==
    frame.output.format
  ) {
    frame.state.compositePipeline =
      device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: frame.state.vertexModule,
          entryPoint: "vs_main",
          buffers: frame.state.vertexBuffers,
        },
        fragment: {
          module: frame.state.compositeModule,
          entryPoint: "fs_main",
          targets: [{
            format: frame.output.format,
          }],
        },
        primitive: {
          topology: "triangle-list",
        },
      });

    frame.state.pipelineFormat =
      frame.output.format;

    // Automatic layouts belong to their pipelines.
    frame.state.compositeBindGroup = null;
  }

  const aspectRatio = inW / inH;

  const extractData =
    frame.state.extractUniformData;
  extractData[0] = threshold;
  extractData[1] = 0.05;
  extractData[2] = originX;
  extractData[3] = originY;
  extractData[4] = originRadius;
  extractData[5] = aspectRatio;
  extractData[6] = 0.0;
  extractData[7] = 0.0;

  writeUniformIfChanged(
    device,
    frame.state.extractUniformBuf,
    extractData,
    frame.state.lastExtractUniformData,
  );

  const blurData = frame.state.blurUniformData;
  blurData[0][0] = radius / 2.0;
  blurData[1][0] = radius / 4.0;
  blurData[2][0] = radius;
  blurData[3][0] = radius;
  blurData[4][0] = radius;
  blurData[5][0] = radius;

  for (let i = 0; i < 6; i++) {
    blurData[i][3] = frame.renderScale ?? 1;
    writeUniformIfChanged(
      device,
      frame.state.blurUniformBufs[i],
      blurData[i],
      frame.state.lastBlurUniformData[i],
    );
  }

  const vigStr =
    p.vignetteStrength / 100.0;
  const vigSoft =
    p.vignetteSoftness / 100.0;
  const compositeData =
    frame.state.compositeUniformData;

  compositeData[0] = intensity;
  compositeData[1] = p.tint.r;
  compositeData[2] = p.tint.g;
  compositeData[3] = p.tint.b;
  compositeData[4] = vigStr;
  compositeData[5] = vigSoft;
  compositeData[6] = p.tint.a;
  compositeData[7] = 0.0;

  writeUniformIfChanged(
    device,
    frame.state.compositeUniformBuf,
    compositeData,
    frame.state.lastCompositeUniformData,
  );

  if (frame.state.inputTexture !== frame.input) {
    frame.state.inputTexture = frame.input;
    frame.state.inputView =
      frame.input.createView();

    frame.state.extractBindGroup =
      device.createBindGroup({
        layout:
          frame.state.extractPipeline
            .getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer:
                frame.state.extractUniformBuf,
            },
          },
          {
            binding: 1,
            resource: frame.state.sampler,
          },
          {
            binding: 2,
            resource: frame.state.inputView,
          },
        ],
      });

    // The composite also references the input.
    frame.state.compositeBindGroup = null;
  }

  if (
    frame.state.outputTexture !== frame.output
  ) {
    frame.state.outputTexture = frame.output;
    frame.state.outputView =
      frame.output.createView();
  }

  if (frame.state.compositeBindGroup == null) {
    frame.state.compositeBindGroup =
      device.createBindGroup({
        layout:
          frame.state.compositePipeline
            .getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer:
                frame.state.compositeUniformBuf,
            },
          },
          {
            binding: 1,
            resource: frame.state.sampler,
          },
          {
            binding: 2,
            resource: frame.state.inputView,
          },
          {
            binding: 3,
            resource: frame.state.half0View,
          },
          {
            binding: 4,
            resource: frame.state.quarter0View,
          },
        ],
      });
  }

  const encoder = device.createCommandEncoder();

  function runPass(
    pipeline,
    bindGroup,
    targetView,
  ) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: "clear",
        clearValue: {
          r: 0,
          g: 0,
          b: 0,
          a: 0,
        },
        storeOp: "store",
      }],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, frame.state.quad);
    pass.draw(6);
    pass.end();
  }

  runPass(
    frame.state.extractPipeline,
    frame.state.extractBindGroup,
    frame.state.extractView,
  );

  for (let i = 0; i < 6; i++) {
    runPass(
      frame.state.blurPipeline,
      frame.state.blurBindGroups[i],
      frame.state.blurTargetViews[i],
    );
  }

  const compositePass = encoder.beginRenderPass({
    colorAttachments: [{
      view: frame.state.outputView,
      loadOp: "clear",
      clearValue: {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
      },
      storeOp: "store",
    }],
  });

  compositePass.setPipeline(
    frame.state.compositePipeline,
  );
  compositePass.setBindGroup(
    0,
    frame.state.compositeBindGroup,
  );
  compositePass.setVertexBuffer(
    0,
    frame.state.quad,
  );
  compositePass.draw(6);
  compositePass.end();

  device.queue.submit([encoder.finish()]);
}

export const manifest = {
  "name": "Bloom multipass (copy)",
  "version": 3,
  "isAnimated": false,
  "usesMouse": false,
  "renderScaleAware": false
}
