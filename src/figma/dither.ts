// @ts-nocheck
// Figma's first-party "Dither" effect (f5c0a2ff-247f-434e-ada4-ecce79213874, version 1c27db85…),
// read with MCP get_shader. Compute pipeline: load (compute) -> dither (compute) -> present (render).
//
// Differences vs. the original source, none of which change the WGSL that gets compiled:
//  - the four error-diffusion shaders were four copies of one template that only differed in the
//    `taps` array and its length; they are generated from ED_KERNELS here instead;
//  - the `defineProperties(...)` block (a no-op outside Figma) is omitted;
//  - the algorithm select in Figma only lists the ordered styles, but the code accepts all of them.

export default function Effect() { }

function bayerMatrix(N) {
    if (N === 1)
        return [[0]];
    var small = bayerMatrix(N / 2);
    var m = N / 2;
    var out = [];
    for (var y = 0; y < N; y++) {
        out[y] = new Array(N);
        for (var x = 0; x < N; x++) {
            var v = small[y % m][x % m] * 4;
            var qx = Math.floor(x / m), qy = Math.floor(y / m);
            var qoff = (qy === 0 && qx === 0) ? 0
                : (qy === 0 && qx === 1) ? 2
                    : (qy === 1 && qx === 0) ? 3 : 1;
            out[y][x] = v + qoff;
        }
    }
    return out;
}
function flattenBayer(N) {
    var m = bayerMatrix(N);
    var data = new Float32Array(N * N);
    var denom = N * N;
    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            data[y * N + x] = (m[y][x] + 0.5) / denom;
        }
    }
    return { data: data, size: N };
}
function rankOrderTile(buf, N) {
    var idx = [];
    for (var i = 0; i < buf.length; i++)
        idx.push(i);
    idx.sort(function (a, b) { return buf[a] - buf[b]; });
    var out = new Float32Array(buf.length);
    for (var rank = 0; rank < idx.length; rank++) {
        out[idx[rank]] = (rank + 0.5) / buf.length;
    }
    return { data: out, size: N };
}
// Deterministic PRNG so the blue-noise tile is stable across runs.
function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function makeBlueNoiseTile(N) {
    var rnd = mulberry32(0x9E3779B9);
    var buf = new Float32Array(N * N);
    for (var i = 0; i < buf.length; i++)
        buf[i] = rnd();
    var tmp = new Float32Array(buf.length);
    for (var pass = 0; pass < 3; pass++) {
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var s = 0, c = 0;
                for (var dy = -2; dy <= 2; dy++) {
                    for (var dx = -2; dx <= 2; dx++) {
                        var xx = (x + dx + N) % N;
                        var yy = (y + dy + N) % N;
                        s += buf[yy * N + xx];
                        c++;
                    }
                }
                tmp[y * N + x] = s / c;
            }
        }
        for (var j = 0; j < buf.length; j++)
            buf[j] = buf[j] - 0.5 * tmp[j];
    }
    return rankOrderTile(buf, N);
}
export function getTile(name) {
    switch (name) {
        case 'bayer2': return flattenBayer(2);
        case 'bayer4': return flattenBayer(4);
        case 'bayer8': return flattenBayer(8);
        case 'bayer16': return flattenBayer(16);
        case 'bluenoise': return makeBlueNoiseTile(64);
        case 'threshold': return { data: new Float32Array([0.5]), size: 1 };
        default: return flattenBayer(4);
    }
}

function buildLoadShader() {
    return `diagnostic(off,derivative_uniformity);
struct LP { width: u32, height: u32, pixelSize: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> P: LP;
@group(0) @binding(1) var<storage, read_write> buf: array<vec4f>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tex: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let dims = vec2f(textureDimensions(tex, 0));
  let center = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) * P.pixelSize / dims;
  let uv = clamp(center, vec2f(0.0), vec2f(1.0));
  let s = textureSampleLevel(tex, samp, uv, 0.0);
  var rgb = vec3f(0.0);
  if (s.a > 0.0) { rgb = s.rgb / s.a; }
  buf[gid.y * P.width + gid.x] = vec4f(rgb, s.a);
}
`;
}

// Error-diffusion kernels: tap list exactly as it appeared in each generated WGSL, plus tap count.
var ED_KERNELS = {
  atkinson: {
    n: 6,
    taps: 'vec3f(1.0, 0.0, 0.12500000), vec3f(2.0, 0.0, 0.12500000), vec3f(-1.0, 1.0, 0.12500000), vec3f(0.0, 1.0, 0.12500000), vec3f(1.0, 1.0, 0.12500000), vec3f(0.0, 2.0, 0.12500000)',
  },
  floyd: {
    n: 4,
    taps: 'vec3f(1.0, 0.0, 0.43750000), vec3f(-1.0, 1.0, 0.18750000), vec3f(0.0, 1.0, 0.31250000), vec3f(1.0, 1.0, 0.06250000)',
  },
  sierra: {
    n: 10,
    taps: 'vec3f(1.0, 0.0, 0.15625000), vec3f(2.0, 0.0, 0.09375000), vec3f(-2.0, 1.0, 0.06250000), vec3f(-1.0, 1.0, 0.12500000), vec3f(0.0, 1.0, 0.15625000), vec3f(1.0, 1.0, 0.12500000), vec3f(2.0, 1.0, 0.06250000), vec3f(-1.0, 2.0, 0.06250000), vec3f(0.0, 2.0, 0.09375000), vec3f(1.0, 2.0, 0.06250000)',
  },
  jarvis: {
    n: 12,
    taps: 'vec3f(1.0, 0.0, 0.14583333), vec3f(2.0, 0.0, 0.10416667), vec3f(-2.0, 1.0, 0.06250000), vec3f(-1.0, 1.0, 0.10416667), vec3f(0.0, 1.0, 0.14583333), vec3f(1.0, 1.0, 0.10416667), vec3f(2.0, 1.0, 0.06250000), vec3f(-2.0, 2.0, 0.02083333), vec3f(-1.0, 2.0, 0.06250000), vec3f(0.0, 2.0, 0.10416667), vec3f(1.0, 2.0, 0.06250000), vec3f(2.0, 2.0, 0.02083333)',
  },
};

function buildEDShader(kernelName) {
  var k = ED_KERNELS[kernelName];
  if (!k) return "";
  return `diagnostic(off,derivative_uniformity);
struct Params {
  width: u32, height: u32, _pad0: u32, _pad1: u32,
  levels: f32, mode: u32, _pad2: u32, _pad3: u32,
  bright: f32, contrast: f32, _pad4: u32, _pad5: u32,
  monoColor: vec4f,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> buf: array<vec4f>;
fn idx(x: i32, y: i32) -> i32 { return y * i32(P.width) + x; }
fn inb(x: i32, y: i32) -> bool { return x >= 0 && y >= 0 && x < i32(P.width) && y < i32(P.height); }
fn quantize(c: f32) -> f32 { let L = P.levels - 1.0; return clamp(round(c * L) / L, 0.0, 1.0); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn applyQuant(c: vec3f) -> vec3f {
  if (P.mode == 0u) { return P.monoColor.rgb * quantize(luma(c)); }
  return vec3f(quantize(c.r), quantize(c.g), quantize(c.b));
}

@compute @workgroup_size(1)
fn main() {
  let W = i32(P.width); let H = i32(P.height);
  let taps = array<vec3f, ${k.n}>(${k.taps});

  // Anti-diagonal scan order: for each diagonal k, process pixels (x, k-x)
  // sequentially so error writes to future pixels are data-race free.
  for (var k: i32 = 0; k < W + H - 1; k = k + 1) {
    let xLo = max(0, k - (H - 1));
    let xHi = min(W - 1, k);
    for (var x: i32 = xLo; x <= xHi; x = x + 1) {
      let y = k - x;
      let i = idx(x, y);
      let cell = buf[i];
      var c = cell.rgb;
      c = (c - 0.5) * P.contrast + 0.5 + P.bright;
      c = clamp(c, vec3f(0.0), vec3f(1.0));
      let q = applyQuant(c);

      var err: vec3f;
      if (P.mode == 0u) { let g = luma(c); err = vec3f(g - quantize(g)); }
      else { err = c - q; }
      buf[i] = vec4f(q, cell.a);

      for (var n: i32 = 0; n < ${k.n}; n = n + 1) {
        let tap = taps[n];
        let nx = x + i32(tap.x);
        let ny = y + i32(tap.y);
        if (inb(nx, ny)) {
          let j = idx(nx, ny);
          let prev = buf[j];
          buf[j] = vec4f(prev.rgb + err * tap.z, prev.a);
        }
      }
    }
  }
}
`;
}
function buildOrderedShader() {
    return `diagnostic(off,derivative_uniformity);
struct Params {
  width: u32, height: u32, tileSize: u32, _pad0: u32,
  levels: f32, mode: u32, _pad1: vec2u,
  bright: f32, contrast: f32, _pad2: vec2f,
  monoColor: vec4f,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> buf: array<vec4f>;
@group(0) @binding(2) var<storage, read> tile: array<f32>;
fn quantize(c: f32, t: f32) -> f32 {
  let L = P.levels - 1.0;
  let off = (t - 0.5) / L;
  return clamp(round((c + off) * L) / L, 0.0, 1.0);
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let i = gid.y * P.width + gid.x;
  let cell = buf[i];
  var c = cell.rgb;
  c = (c - 0.5) * P.contrast + 0.5 + P.bright;
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  let tx = gid.x % P.tileSize;
  let ty = gid.y % P.tileSize;
  let th = tile[ty * P.tileSize + tx];
  var q: vec3f;
  if (P.mode == 0u) {
    q = P.monoColor.rgb * quantize(luma(c), th);
  } else {
    q = vec3f(quantize(c.r, th), quantize(c.g, th), quantize(c.b, th));
  }
  buf[i] = vec4f(q, cell.a);
}
`;
}
function buildRiemersmaShader() {
    return `diagnostic(off,derivative_uniformity);
struct Params {
  width: u32, height: u32, n: u32, mode: u32,
  levels: f32, bright: f32, contrast: f32, _pad: f32,
  monoColor: vec4f,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> buf: array<vec4f>;
fn idx(x: u32, y: u32) -> u32 { return y * P.width + x; }
fn quantize(c: f32) -> f32 { let L = P.levels - 1.0; return clamp(round(c * L) / L, 0.0, 1.0); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn applyQuant(c: vec3f) -> vec3f {
  if (P.mode == 0u) { return P.monoColor.rgb * quantize(luma(c)); }
  return vec3f(quantize(c.r), quantize(c.g), quantize(c.b));
}
fn hilbertXY(d0: u32, n: u32) -> vec2u {
  var d = d0;
  var x = 0u; var y = 0u; var s = 1u;
  while (s < n) {
    let rx = (d >> 1u) & 1u;
    let ry = (d ^ rx) & 1u;
    if (ry == 0u) {
      if (rx == 1u) { x = s - 1u - x; y = s - 1u - y; }
      let tmp = x; x = y; y = tmp;
    }
    x = x + s * rx;
    y = y + s * ry;
    d = d / 4u;
    s = s * 2u;
  }
  return vec2u(x, y);
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u || gid.y != 0u || gid.z != 0u) { return; }

  var weights: array<f32, 16>;
  let ratio = pow(1.0 / 16.0, 1.0 / 16.0);
  var sumW = 0.0;
  for (var i = 0u; i < 16u; i = i + 1u) {
    weights[i] = pow(ratio, f32(i + 1u));
    sumW = sumW + weights[i];
  }
  for (var i = 0u; i < 16u; i = i + 1u) { weights[i] = weights[i] / sumW; }

  var errR: array<f32, 16>;
  var errG: array<f32, 16>;
  var errB: array<f32, 16>;
  var head = 0u;
  let total = P.n * P.n;

  for (var step = 0u; step < total; step = step + 1u) {
    let p = hilbertXY(step, P.n);
    if (p.x >= P.width || p.y >= P.height) { continue; }

    var acc = vec3f(0.0);
    for (var kk = 0u; kk < 16u; kk = kk + 1u) {
      let h = (head + kk) % 16u;
      acc = acc + vec3f(errR[h], errG[h], errB[h]) * weights[kk];
    }

    let i = idx(p.x, p.y);
    let cell = buf[i];
    var c = cell.rgb + acc;
    c = (c - 0.5) * P.contrast + 0.5 + P.bright;
    c = clamp(c, vec3f(0.0), vec3f(1.0));
    let q = applyQuant(c);

    if (P.mode == 0u) {
      let g = luma(c);
      let e = g - quantize(g);
      errR[head] = e; errG[head] = e; errB[head] = e;
    } else {
      let e = c - q;
      errR[head] = e.r; errG[head] = e.g; errB[head] = e.b;
    }
    head = (head + 15u) % 16u;
    buf[i] = vec4f(q, cell.a);
  }
}
`;
}
function buildPresentShader() {
    return `diagnostic(off,derivative_uniformity);
struct PP { dimX: f32, dimY: f32, pixelSize: f32, fW: f32, fH: f32, _a: f32, _b: f32, _c: f32 };
@group(0) @binding(0) var<uniform> P: PP;
@group(0) @binding(1) var<storage, read> buf: array<vec4f>;

struct VsIn { @location(0) pos: vec2f, @location(1) uv: vec2f };
struct VsOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.position = vec4f(in.pos, 0.0, 1.0);
  out.uv = in.uv;
  return out;
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
  let W = i32(P.fW); let H = i32(P.fH);
  var cx = i32(floor(in.uv.x * P.dimX / P.pixelSize));
  var cy = i32(floor(in.uv.y * P.dimY / P.pixelSize));
  cx = clamp(cx, 0, W - 1);
  cy = clamp(cy, 0, H - 1);
  let p = buf[cy * W + cx];
  if (p.a <= 0.0) { return vec4f(0.0); }
  return vec4f(p.rgb * p.a, p.a);
}
`;
}
function getALGO_MAP() {
    return {
        'Atkinson': { fam: 'ed', kernel: 'atkinson' },
        'Floyd-Steinberg': { fam: 'ed', kernel: 'floyd' },
        'Sierra': { fam: 'ed', kernel: 'sierra' },
        'Jarvis': { fam: 'ed', kernel: 'jarvis' },
        'Bayer 2x2': { fam: 'ord', tile: 'bayer2' },
        'Bayer 4x4': { fam: 'ord', tile: 'bayer4' },
        'Bayer 8x8': { fam: 'ord', tile: 'bayer8' },
        'Bayer 16x16': { fam: 'ord', tile: 'bayer16' },
        'Blue Noise': { fam: 'ord', tile: 'bluenoise' },
        'Threshold': { fam: 'ord', tile: 'threshold' },
        'Riemersma': { fam: 'curve' },
    };
}
function nextPowerOfTwo(n) {
    return 1 << Math.ceil(Math.log2(Math.max(1, n)));
}
export function setup(device, frame) {
    var s = frame.state;
    // Fullscreen quad reused by the present pass.
    s.quad = device.createBuffer({
        size: 6 * 4 * 4,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true,
    });
    new Float32Array(s.quad.getMappedRange()).set([
        -1, -1, 0, 1,
        1, -1, 1, 1,
        -1, 1, 0, 0,
        -1, 1, 0, 0,
        1, -1, 1, 1,
        1, 1, 1, 0,
    ]);
    s.quad.unmap();
    s.sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
    });
    s.edPipelines = {};
    s.tileBufs = {};
}
function getLoadPipeline(device, s) {
    if (!s.loadPipeline) {
        var module = device.createShaderModule({ code: buildLoadShader() });
        s.loadPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    return s.loadPipeline;
}
function getOrderedPipeline(device, s) {
    if (!s.orderedPipeline) {
        var module = device.createShaderModule({ code: buildOrderedShader() });
        s.orderedPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    return s.orderedPipeline;
}
function getRiemersmaPipeline(device, s) {
    if (!s.riemersmaPipeline) {
        var module = device.createShaderModule({ code: buildRiemersmaShader() });
        s.riemersmaPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    return s.riemersmaPipeline;
}
function getEDPipeline(device, s, kernelName) {
    if (!s.edPipelines[kernelName]) {
        var module = device.createShaderModule({ code: buildEDShader(kernelName) });
        s.edPipelines[kernelName] = device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });
    }
    return s.edPipelines[kernelName];
}
function getPresentPipeline(device, s, format) {
    if (s.presentPipeline && s.presentFormat === format)
        return s.presentPipeline;
    var module = device.createShaderModule({ code: buildPresentShader() });
    s.presentPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module, entryPoint: 'vs_main',
            buffers: [{
                    arrayStride: 16,
                    attributes: [
                        { shaderLocation: 0, format: 'float32x2', offset: 0 },
                        { shaderLocation: 1, format: 'float32x2', offset: 8 },
                    ],
                }],
        },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
    });
    s.presentFormat = format;
    return s.presentPipeline;
}
function ensurePixelBuf(device, s, W, H) {
    if (s.pixelBuf && s.bufW === W && s.bufH === H)
        return s.pixelBuf;
    if (s.pixelBuf)
        s.pixelBuf.destroy();
    s.pixelBuf = device.createBuffer({
        size: W * H * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    s.bufW = W;
    s.bufH = H;
    return s.pixelBuf;
}
function ensureTileBuf(device, s, name) {
    if (s.tileBufs[name])
        return s.tileBufs[name];
    var tile = getTile(name);
    var buf = device.createBuffer({
        size: Math.max(tile.data.byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, tile.data);
    var entry = { buffer: buf, size: tile.size };
    s.tileBufs[name] = entry;
    return entry;
}
export function render(device, frame) {
    if (frame.input == null)
        return;
    var s = frame.state;
    var dimX = (frame.input.physicalWidth ?? frame.input.width);
    var dimY = (frame.input.physicalHeight ?? frame.input.height);
    if (!dimX || !dimY)
        return;
    var pixelSize = frame.params.pixelSize * Math.max(Number(frame.renderScale) || 1, 0.000001);
    var levels = frame.params.levels;
    var bright = (frame.params.brightness - 100) / 200;
    var contrast = frame.params.contrast;
    var mode = frame.params.mono ? 0 : 1;
    var mc = frame.params.monoColor;
    var W = Math.max(1, Math.ceil(dimX / pixelSize));
    var H = Math.max(1, Math.ceil(dimY / pixelSize));
    var algoStr = frame.params.algorithm;
    var algoMap = getALGO_MAP();
    var algo = algoMap[algoStr] || algoMap['Bayer 8x8'];
    var pixelBuf = ensurePixelBuf(device, s, W, H);
    // --- 1. load pass ---------------------------------------------------------
    var loadPipe = getLoadPipeline(device, s);
    if (!s.loadUbuf) {
        s.loadUbuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    var loadParams = new ArrayBuffer(16);
    var ldv = new DataView(loadParams);
    ldv.setUint32(0, W, true);
    ldv.setUint32(4, H, true);
    ldv.setFloat32(8, pixelSize, true);
    device.queue.writeBuffer(s.loadUbuf, 0, loadParams);
    var loadBG = device.createBindGroup({
        layout: loadPipe.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: s.loadUbuf } },
            { binding: 1, resource: { buffer: pixelBuf } },
            { binding: 2, resource: s.sampler },
            { binding: 3, resource: frame.input.createView() },
        ],
    });
    var encoder = device.createCommandEncoder();
    var loadPass = encoder.beginComputePass();
    loadPass.setPipeline(loadPipe);
    loadPass.setBindGroup(0, loadBG);
    loadPass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    loadPass.end();
    // --- 2. dither pass -------------------------------------------------------
    if (algo.fam === 'ed') {
        var edPipe = getEDPipeline(device, s, algo.kernel);
        if (!s.edUbuf) {
            s.edUbuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        var edData = new ArrayBuffer(64);
        var edv = new DataView(edData);
        edv.setUint32(0, W, true);
        edv.setUint32(4, H, true);
        edv.setFloat32(16, levels, true);
        edv.setUint32(20, mode, true);
        edv.setFloat32(32, bright, true);
        edv.setFloat32(36, contrast, true);
        edv.setFloat32(48, mc.r, true);
        edv.setFloat32(52, mc.g, true);
        edv.setFloat32(56, mc.b, true);
        edv.setFloat32(60, 1, true);
        device.queue.writeBuffer(s.edUbuf, 0, edData);
        var edBG = device.createBindGroup({
            layout: edPipe.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: s.edUbuf } },
                { binding: 1, resource: { buffer: pixelBuf } },
            ],
        });
        var edPass = encoder.beginComputePass();
        edPass.setPipeline(edPipe);
        edPass.setBindGroup(0, edBG);
        edPass.dispatchWorkgroups(1);
        edPass.end();
    }
    else if (algo.fam === 'ord') {
        var ordPipe = getOrderedPipeline(device, s);
        var tile = ensureTileBuf(device, s, algo.tile);
        if (!s.ordUbuf) {
            s.ordUbuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        var ordParams = new ArrayBuffer(64);
        var odv = new DataView(ordParams);
        odv.setUint32(0, W, true);
        odv.setUint32(4, H, true);
        odv.setUint32(8, tile.size, true);
        odv.setFloat32(16, levels, true);
        odv.setUint32(20, mode, true);
        odv.setFloat32(32, bright, true);
        odv.setFloat32(36, contrast, true);
        odv.setFloat32(48, mc.r, true);
        odv.setFloat32(52, mc.g, true);
        odv.setFloat32(56, mc.b, true);
        odv.setFloat32(60, 1, true);
        device.queue.writeBuffer(s.ordUbuf, 0, ordParams);
        var ordBG = device.createBindGroup({
            layout: ordPipe.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: s.ordUbuf } },
                { binding: 1, resource: { buffer: pixelBuf } },
                { binding: 2, resource: { buffer: tile.buffer } },
            ],
        });
        var ordPass = encoder.beginComputePass();
        ordPass.setPipeline(ordPipe);
        ordPass.setBindGroup(0, ordBG);
        ordPass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
        ordPass.end();
    }
    else {
        var rPipe = getRiemersmaPipeline(device, s);
        if (!s.rUbuf) {
            s.rUbuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        var rParams = new ArrayBuffer(48);
        var rdv = new DataView(rParams);
        rdv.setUint32(0, W, true);
        rdv.setUint32(4, H, true);
        rdv.setUint32(8, nextPowerOfTwo(Math.max(W, H)), true);
        rdv.setUint32(12, mode, true);
        rdv.setFloat32(16, levels, true);
        rdv.setFloat32(20, bright, true);
        rdv.setFloat32(24, contrast, true);
        rdv.setFloat32(32, mc.r, true);
        rdv.setFloat32(36, mc.g, true);
        rdv.setFloat32(40, mc.b, true);
        rdv.setFloat32(44, 1, true);
        device.queue.writeBuffer(s.rUbuf, 0, rParams);
        var rBG = device.createBindGroup({
            layout: rPipe.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: s.rUbuf } },
                { binding: 1, resource: { buffer: pixelBuf } },
            ],
        });
        var rPass = encoder.beginComputePass();
        rPass.setPipeline(rPipe);
        rPass.setBindGroup(0, rBG);
        rPass.dispatchWorkgroups(1);
        rPass.end();
    }
    // --- 3. present pass ------------------------------------------------------
    var presentPipe = getPresentPipeline(device, s, frame.output.format);
    if (!s.presentUbuf) {
        s.presentUbuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    var pParams = new ArrayBuffer(32);
    var pdv = new DataView(pParams);
    pdv.setFloat32(0, dimX, true);
    pdv.setFloat32(4, dimY, true);
    pdv.setFloat32(8, pixelSize, true);
    pdv.setFloat32(12, W, true);
    pdv.setFloat32(16, H, true);
    device.queue.writeBuffer(s.presentUbuf, 0, pParams);
    var presentBG = device.createBindGroup({
        layout: presentPipe.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: s.presentUbuf } },
            { binding: 1, resource: { buffer: pixelBuf } },
        ],
    });
    var pass = encoder.beginRenderPass({
        colorAttachments: [{
                view: frame.output.createView(),
                loadOp: 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: 'store',
            }],
    });
    pass.setPipeline(presentPipe);
    pass.setBindGroup(0, presentBG);
    pass.setVertexBuffer(0, s.quad);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
}

export const manifest = {
  "name": "Dither",
  "version": 3,
  "isAnimated": false,
  "usesMouse": false,
  "renderScaleAware": true
}
