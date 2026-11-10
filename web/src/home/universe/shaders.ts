// Three pipelines: soft instanced sprites (stars, bodies, rings, haze), points for the dust and thin glowing lines.
export const SPRITE_FLOATS = 9; // position 3, world size, min half size in px, rgb, alpha

const spriteVS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in float aSize;
layout(location=3) in float aMinPx;
layout(location=4) in vec4 aColor;
layout(location=5) in vec2 aState; // alpha factor, size factor
layout(location=6) in vec2 aStyle; // what kind of star (see layout.ts), notes per square world unit of its constellation
uniform mat4 uVP;
uniform vec2 uRes;
uniform float uPx;
uniform float uScale;
uniform float uFade;
uniform float uFloor; // what is left of the size in px when the map is far away: a fixed size would melt a cluster into one blot
uniform float uFloorMin;
const float CROWD_PX = 7.0; // neighbours closer than this on screen share their light
const float CROWD_LEAST = 0.16;
out vec2 vUv;
out vec4 vColor;
out float vHalf;
flat out int vStyle;
flat out float vSeed;
void main() {
  vStyle = int(aStyle.x + 0.5);
  vSeed = fract(dot(aPos, vec3(0.1031, 0.1173, 0.0879))) * 6.2832; // the axis of a double star or a pulsar's beams
  vec4 clip = uVP * vec4(aPos, 1.0);
  float pxPerWorld = uPx / max(clip.w, 0.001);
  float rest = max(max(aMinPx * uFloor, uFloorMin) * uScale, aSize * pxPerWorld);
  // Light adds up: a cluster shrinks on screen with the square of the distance, its stars cannot. So nothing outgrows the room it has
  // among its neighbours, and past a certain density each star gives less, which holds the light per pixel of a cluster constant at any distance.
  float exposure = 1.0;
  if (aStyle.y > 0.0) {
    float room = pxPerWorld / sqrt(aStyle.y);
    rest = min(rest, max(uFloorMin * uScale, room * 1.2));
    exposure = clamp(room * room / (CROWD_PX * CROWD_PX * uScale * uScale), CROWD_LEAST, 1.0);
  }
  float half_ = min(rest * aState.y, uRes.y * 1.4);
  vec2 off = aCorner * half_ * 2.0 / uRes;
  gl_Position = vec4(clip.xy + off * clip.w, clip.z, clip.w);
  vUv = aCorner;
  vHalf = half_ / uScale;
  vColor = vec4(aColor.rgb, aColor.a * aState.x * uFade * exposure);
}`;

const spriteFS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vHalf;
flat in int vStyle;
flat in float vSeed;
uniform int uShape;
out vec4 frag;
const float STAR_CROP_PX = 6.0;
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float a;
  vec3 c = vColor.rgb;
  if (uShape == 1) {
    // Nebula: wide Gaussian that reaches zero at the quad edge.
    a = exp(-r * r * 4.0) * (1.0 - r * r);
  } else if (uShape == 2) {
    // Note star: hard white core, tight halo, wide glow. Each kind is one branch here, not a draw call of its own.
    // A small star is the centre of a bigger one: the core stays a crisp point of the same few pixels, it is the glow that goes.
    vec2 uv = vUv * min(1.0, vHalf / STAR_CROP_PX);
    float r = length(uv);
    vec2 axis = vec2(cos(vSeed), sin(vSeed));
    if (vStyle == 5) {
      // The central star of a project: its own colour, white only at the very heart, a wide corona, four long rays once it is big enough to carry them.
      float heart = smoothstep(0.1, 0.03, r);
      float body = smoothstep(0.26, 0.12, r);
      float rim = 1.0 - r;
      float corona = exp(-r * r * 26.0) * 0.5 + exp(-r * r * 6.0) * 0.16 * rim;
      float grow = clamp((vHalf - 12.0) / 20.0, 0.0, 1.0);
      vec2 p = abs(uv);
      float rays = (exp(-p.y * 90.0) * pow(max(0.0, 1.0 - p.x), 3.0) + exp(-p.x * 90.0) * pow(max(0.0, 1.0 - p.y), 3.0)) * 0.5 * grow;
      // Squared: the palette is pastel, and a pastel at full light is nearly white.
      c = mix(mix(c, c * c, 0.6), vec3(1.0), heart * 0.9);
      a = min(body + corona + rays, 1.0) + heart * 0.2 + rays * 0.3;
    } else if (vStyle == 3) {
      // A double star: two cores, the smaller one colder.
      float r1 = length(uv - axis * 0.2);
      float r2 = length(uv + axis * 0.2);
      float small = smoothstep(0.09, 0.03, r2);
      c = mix(mix(c, vec3(1.0), smoothstep(0.13, 0.05, r1) * 0.42), vec3(0.72, 0.84, 1.0), small * 0.8);
      a = smoothstep(0.13, 0.05, r1) + small * 0.9 + exp(-r1 * r1 * 60.0) * 0.4 + exp(-r2 * r2 * 80.0) * 0.28 + exp(-r * r * 10.0) * 0.08;
    } else if (vStyle == 4) {
      // A pulsar: a point of light and two thin opposite beams.
      float along = abs(dot(uv, axis));
      float across = abs(dot(uv, vec2(-axis.y, axis.x)));
      float core = smoothstep(0.09, 0.03, r);
      c = mix(mix(c, vec3(0.74, 0.9, 1.0), 0.55), vec3(1.0), core * 0.5);
      a = core + exp(-r * r * 70.0) * 0.5 + exp(-across * 60.0) * pow(1.0 - along, 2.5) * 0.85;
    } else {
      float wide = vStyle == 2 ? 1.0 : 0.0;
      float tiny = vStyle == 1 ? 1.0 : 0.0;
      float core = smoothstep(0.19 + wide * 0.07 - tiny * 0.08, 0.09 - tiny * 0.04, r);
      float halo = exp(-r * r * (50.0 - wide * 30.0 + tiny * 25.0)) * 0.55 + exp(-r * r * (10.0 - wide * 5.0)) * (0.1 + wide * 0.08 - tiny * 0.08);
      float spikes = 0.0;
      float grow = clamp((vHalf - 17.0) / 9.0, 0.0, 1.0) * (1.0 - tiny);
      if (grow > 0.0) {
        vec2 p = abs(uv);
        spikes = (exp(-p.y * 110.0) * pow(1.0 - p.x, 4.0) + exp(-p.x * 110.0) * pow(1.0 - p.y, 4.0)) * 0.5 * grow;
      }
      // A star of a few pixels is all core: whitening it would turn a far cluster white whatever its colour. The colour goes first, the white comes with size.
      float near_ = smoothstep(3.0, 9.0, vHalf);
      c = mix(mix(c, c * c, 0.5), vec3(1.0), core * 0.3 * near_);
      a = min(core + halo + spikes, 1.0 + near_ * 0.3);
    }
  } else {
    // Ring around a hovered or selected star.
    a = smoothstep(0.075, 0.0, abs(r - 0.78)) * 0.95;
  }
  frag = vec4(c * a * vColor.a, 1.0);
}`;

// Tens of thousands of dots a few pixels wide: one vertex each and no branches. Most of a frame on a weak GPU went to these as quads.
const dustVS = `#version 300 es
layout(location=1) in vec3 aPos;
layout(location=3) in float aMinPx;
layout(location=4) in vec4 aColor;
uniform mat4 uVP;
uniform float uScale;
uniform float uFade;
flat out vec3 vColor;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  gl_PointSize = aMinPx * uScale * 2.0;
  vColor = aColor.rgb * aColor.a * uFade;
}`;

const dustFS = `#version 300 es
precision mediump float;
flat in vec3 vColor;
out vec4 frag;
void main() {
  float a = max(0.0, 1.0 - length(gl_PointCoord * 2.0 - 1.0));
  frag = vec4(vColor * a * a, 1.0);
}`;

const lineVS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in vec4 aColor;
uniform mat4 uVP;
uniform vec2 uRes;
uniform float uWidth;
out vec4 vColor;
out float vSide;
out float vT;
void main() {
  vec4 a = uVP * vec4(aA, 1.0);
  vec4 b = uVP * vec4(aB, 1.0);
  float t = aCorner.x * 0.5 + 0.5;
  vec2 sa = a.xy / max(a.w, 0.001) * uRes;
  vec2 sb = b.xy / max(b.w, 0.001) * uRes;
  vec2 dir = normalize(sb - sa + vec2(0.0001, 0.0));
  // The shorter a line on screen, the more of them per pixel: a figure far away is a few faint threads instead of a solid fan. A negative alpha asks to be left out of this.
  float span = length(sb - sa) * 0.5 / uWidth;
  float thin = aColor.a < 0.0 ? 1.0 : mix(0.2, 1.0, smoothstep(3.0, 34.0, span));
  vec2 n = vec2(-dir.y, dir.x);
  vec4 p = mix(a, b, t);
  p.xy += n * aCorner.y * uWidth * 2.0 / uRes * p.w;
  gl_Position = (a.w <= 0.0 || b.w <= 0.0) ? vec4(2.0, 2.0, 2.0, 1.0) : p;
  vColor = vec4(aColor.rgb, abs(aColor.a) * thin);
  vSide = aCorner.y;
  vT = t;
}`;

const lineFS = `#version 300 es
precision highp float;
in vec4 vColor;
in float vSide;
in float vT;
uniform float uGap;
out vec4 frag;
void main() {
  // Star-chart habit: a line stops short of the stars it connects.
  float ends = smoothstep(0.0, uGap, vT) * smoothstep(1.0, 1.0 - uGap, vT);
  float a = (1.0 - vSide * vSide) * ends;
  frag = vec4(vColor.rgb * a * vColor.a, 1.0);
}`;

// Nebulae are huge and smooth, so they are drawn at a quarter of the resolution and stretched back.
// That removes nearly all the overdraw. The noise hides banding in the faint gradients.
const compositeVS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const compositeFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uNoise;
out vec4 frag;
void main() {
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  frag = vec4(texture(uTex, vUv).rgb + noise * uNoise, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  const u = (name: string) => gl.getUniformLocation(p, name);
  return { p, u };
}

export function spriteProgram(gl: WebGL2RenderingContext) {
  const { p, u } = program(gl, spriteVS, spriteFS);
  return { p, vp: u('uVP'), res: u('uRes'), px: u('uPx'), scale: u('uScale'), fade: u('uFade'), shape: u('uShape'), floor: u('uFloor'), floorMin: u('uFloorMin') };
}

export function dustProgram(gl: WebGL2RenderingContext) {
  const { p, u } = program(gl, dustVS, dustFS);
  return { p, vp: u('uVP'), scale: u('uScale'), fade: u('uFade') };
}

export function compositeProgram(gl: WebGL2RenderingContext) {
  const { p, u } = program(gl, compositeVS, compositeFS);
  return { p, tex: u('uTex'), noise: u('uNoise') };
}

export function lineProgram(gl: WebGL2RenderingContext) {
  const { p, u } = program(gl, lineVS, lineFS);
  return { p, vp: u('uVP'), res: u('uRes'), width: u('uWidth'), gap: u('uGap') };
}
