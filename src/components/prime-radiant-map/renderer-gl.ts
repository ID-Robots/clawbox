/**
 * The Map in raw WebGL2: ONE instanced draw for every node — a round,
 * shaded billboard sized by degree, never smaller on screen than the view's
 * floor — and ONE `GL_LINES` draw for every edge (a fainter one before it for
 * the related hints, a small one after it only for a selected page's own
 * edges). All read the same position buffer, so a layout step is one
 * `bufferSubData`, and the edge index buffers only change when a domain is
 * shown or hidden.
 *
 * Node state (hidden, dimmed, matched, selected, hovered) is one byte per
 * node the shaders read, so a search or a selection never touches positions.
 */
import type { Renderer } from "./view";

export const STATE_HIDDEN = 1;
export const STATE_DIM = 2;
export const STATE_MATCH = 4;
export const STATE_SELECTED = 8;
export const STATE_HOVER = 16;

const NODE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_pos;
layout(location=2) in vec4 a_color;
layout(location=3) in float a_size;
layout(location=4) in uint a_state;
uniform mat4 u_vp;
uniform vec2 u_viewport;
uniform float u_scale;
uniform vec2 u_fog;
uniform vec3 u_bg;
uniform float u_min;
out vec2 v_uv;
out vec3 v_color;
flat out uint v_state;
void main() {
  v_state = a_state;
  if ((a_state & 1u) != 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 clip = u_vp * vec4(a_pos, 1.0);
  float boost = 1.0;
  if ((a_state & 8u) != 0u) boost = 1.7;
  else if ((a_state & 16u) != 0u) boost = 1.45;
  else if ((a_state & 4u) != 0u) boost = 1.25;
  // Device pixels; the floor keeps a page with no links (the smallest node) a dot you can see and click.
  float px = max(u_min, a_size * u_scale / max(clip.w, 0.001)) * boost;
  clip.xy += a_corner * px * 2.0 / u_viewport * clip.w;
  gl_Position = clip;
  v_uv = a_corner;
  vec3 c = a_color.rgb;
  if ((a_state & 2u) != 0u) c = mix(c, u_bg, 0.82);
  else if ((a_state & 28u) != 0u) c = mix(c, vec3(1.0), 0.2);
  v_color = mix(c, u_bg, smoothstep(u_fog.x, u_fog.y, clip.w) * 0.6);
}`;

const NODE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_color;
flat in uint v_state;
out vec4 o;
void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  vec3 c = v_color * (1.0 - 0.3 * d * d);
  if ((v_state & 8u) != 0u && d > 0.74) c = vec3(1.0);
  float a = 1.0 - smoothstep(0.86, 1.0, d);
  o = vec4(c * a, a);
}`;

// Edges are a quiet neutral grey whatever the nodes' colours.
const EDGE_VS = `#version 300 es
layout(location=1) in vec3 a_pos;
layout(location=4) in uint a_state;
uniform mat4 u_vp;
uniform float u_alpha;
out vec4 v_color;
void main() {
  gl_Position = u_vp * vec4(a_pos, 1.0);
  float a = (a_state & 2u) != 0u ? u_alpha * 0.2 : u_alpha;
  v_color = vec4(vec3(0.66, 0.68, 0.72) * a, a);
}`;

const EDGE_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() { o = v_color; }`;

/** The page's background, which dimmed and distant nodes fade toward. */
const BG: [number, number, number] = [0.043, 0.051, 0.075];

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
  return program;
}

export class GLRenderer implements Renderer {
  readonly kind = "webgl";
  private readonly nodeProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly edgeVao: WebGLVertexArrayObject;
  private readonly hiVao: WebGLVertexArrayObject;
  private readonly weakVao: WebGLVertexArrayObject;
  private readonly buffers: Record<"corner" | "pos" | "color" | "size" | "state" | "edges" | "hi" | "weak", WebGLBuffer>;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private n = 0;
  private edgeCount = 0;
  private hiCount = 0;
  private weakCount = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.nodeProgram = compile(gl, NODE_VS, NODE_FS);
    this.edgeProgram = compile(gl, EDGE_VS, EDGE_FS);
    for (const name of ["u_vp", "u_viewport", "u_scale", "u_fog", "u_bg", "u_min"]) this.u[`n${name}`] = gl.getUniformLocation(this.nodeProgram, name);
    for (const name of ["u_vp", "u_alpha"]) this.u[`e${name}`] = gl.getUniformLocation(this.edgeProgram, name);
    const buffer = () => gl.createBuffer()!;
    this.buffers = { corner: buffer(), pos: buffer(), color: buffer(), size: buffer(), state: buffer(), edges: buffer(), hi: buffer(), weak: buffer() };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const attributes = (instanced: boolean) => {
      const div = instanced ? 1 : 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.pos);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, div);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.vertexAttribDivisor(2, div);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.state);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_BYTE, 0, 0);
      gl.vertexAttribDivisor(4, div);
    };

    this.nodeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.corner);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    attributes(true);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.size);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    this.edgeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.edgeVao);
    attributes(false);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.edges);

    this.hiVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.hiVao);
    attributes(false);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.hi);

    this.weakVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.weakVao);
    attributes(false);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.weak);
    gl.bindVertexArray(null);
  }

  private upload(target: "pos" | "color" | "size" | "state", data: ArrayBufferView, usage: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[target]);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  }

  setNodes(n: number, sizes: Float32Array): void {
    this.n = n;
    this.upload("size", sizes, this.gl.STATIC_DRAW);
    this.upload("pos", new Float32Array(n * 3), this.gl.DYNAMIC_DRAW);
  }

  setPositions(pos: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos, 0, Math.min(pos.length, this.n * 3));
  }

  setColors(rgba: Uint8Array): void {
    this.upload("color", rgba, this.gl.STATIC_DRAW);
  }

  setStates(states: Uint8Array): void {
    this.upload("state", states, this.gl.DYNAMIC_DRAW);
  }

  setEdges(visible: Uint32Array, highlighted: Uint32Array, weak: Uint32Array): void {
    const gl = this.gl;
    // Element buffers belong to their vertex arrays: bind the array, not just the buffer.
    gl.bindVertexArray(this.edgeVao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, visible, gl.STATIC_DRAW);
    gl.bindVertexArray(this.hiVao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, highlighted, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.weakVao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, weak, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.edgeCount = visible.length;
    this.hiCount = highlighted.length;
    this.weakCount = weak.length;
  }

  draw(vp: Float32Array, width: number, height: number, scale: number, fog: [number, number], _dpr: number, minPx: number): void {
    const gl = this.gl;
    const u = this.u;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.edgeProgram);
    gl.uniformMatrix4fv(u.eu_vp, false, vp);
    // Fainter as edges multiply, so a dense core stays a structure, not a white blot.
    const alpha = Math.max(0.05, 0.18 * Math.sqrt(3000 / Math.max(3000, (this.edgeCount + this.weakCount) / 2))) * (this.hiCount > 0 ? 0.5 : 1);
    if (this.weakCount > 0) {
      // A related hint is a guess: a ghost of a line under the real ones.
      gl.uniform1f(u.eu_alpha, alpha * 0.45);
      gl.bindVertexArray(this.weakVao);
      gl.drawElements(gl.LINES, this.weakCount, gl.UNSIGNED_INT, 0);
    }
    if (this.edgeCount > 0) {
      gl.uniform1f(u.eu_alpha, alpha);
      gl.bindVertexArray(this.edgeVao);
      gl.drawElements(gl.LINES, this.edgeCount, gl.UNSIGNED_INT, 0);
    }
    if (this.hiCount > 0) {
      gl.uniform1f(u.eu_alpha, 0.75);
      gl.bindVertexArray(this.hiVao);
      gl.drawElements(gl.LINES, this.hiCount, gl.UNSIGNED_INT, 0);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.nodeProgram);
    gl.uniformMatrix4fv(u.nu_vp, false, vp);
    gl.uniform2f(u.nu_viewport, width, height);
    gl.uniform1f(u.nu_scale, scale);
    gl.uniform2f(u.nu_fog, fog[0], fog[1]);
    gl.uniform3f(u.nu_bg, BG[0], BG[1], BG[2]);
    gl.uniform1f(u.nu_min, minPx);
    gl.bindVertexArray(this.nodeVao);
    if (this.n > 0) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of Object.values(this.buffers)) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.nodeVao);
    gl.deleteVertexArray(this.edgeVao);
    gl.deleteVertexArray(this.hiVao);
    gl.deleteVertexArray(this.weakVao);
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
  }
}
