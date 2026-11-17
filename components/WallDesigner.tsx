'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent } from 'react'

/* ----------------------------- types & constants ---------------------------- */

type Pt = { x: number; y: number } // normalized 0..1, origin top-left
type Size = { w: number; h: number } // feet
type Unit = 'ft' | 'in' | 'cm'

const DEFAULT_TILE_IMAGE = '/tile.jpg'
const MAX_PHOTO_SIDE = 2048
const UNIT_TO_FT: Record<Unit, number> = { ft: 1, in: 1 / 12, cm: 1 / 30.48 }

const PRESETS: { label: string; size: Size }[] = [
  { label: '2 × 2 ft', size: { w: 2, h: 2 } },
  { label: '4 × 2 ft', size: { w: 4, h: 2 } },
  { label: '6 × 6 ft', size: { w: 6, h: 6 } },
]

const DEFAULT_CORNERS: Pt[] = [
  { x: 0.15, y: 0.2 }, // top-left
  { x: 0.85, y: 0.2 }, // top-right
  { x: 0.85, y: 0.8 }, // bottom-right
  { x: 0.15, y: 0.8 }, // bottom-left
]

/* --------------------------------- homography -------------------------------- */

/** Solves the 3x3 projective transform mapping quad (4 pts) -> unit square. Returns column-major mat3. */
function quadToUnitHomography(q: Pt[]): Float32Array | null {
  const dst = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = q[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination with partial pivoting (8 unknowns)
  for (let c = 0; c < 8; c++) {
    let piv = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    if (Math.abs(A[piv][c]) < 1e-12) return null
    ;[A[c], A[piv]] = [A[piv], A[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]
    }
  }
  const h = A.map((row, i) => row[8] / row[i])
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] // row-major
  // make w positive at the quad centroid
  const cx = q.reduce((s, p) => s + p.x, 0) / 4
  const cy = q.reduce((s, p) => s + p.y, 0) / 4
  const w = H[6] * cx + H[7] * cy + H[8]
  const s = w < 0 ? -1 : 1
  // column-major for GL
  return new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]].map((n) => n * s))
}

/* ----------------------------------- WebGL ---------------------------------- */

const VERT = `#version 300 es
in vec2 a;
out vec2 vUv;
void main(){ vUv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBg;
uniform sampler2D uTile;
uniform mat3 uH;
uniform vec2 uWall;     // wall size in feet
uniform vec2 uTileSize; // tile size in feet
uniform float uGrout;   // feet
uniform float uBrick;   // 0 or 1
uniform float uBright;
uniform float uShow;    // 0 = no tiles
void main(){
  vec4 bg = texture(uBg, vUv);
  if (uShow < 0.5) { outColor = vec4(bg.rgb, 1.0); return; }
  vec2 n = vec2(vUv.x, 1.0 - vUv.y);
  vec3 p = uH * vec3(n, 1.0);
  if (p.z <= 0.0) { outColor = vec4(bg.rgb, 1.0); return; }
  vec2 q = p.xy / p.z;
  float fw = max(fwidth(q.x), fwidth(q.y));
  float edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
  float alpha = smoothstep(-fw, fw, edge);
  if (alpha <= 0.0) { outColor = vec4(bg.rgb, 1.0); return; }

  vec2 t0 = (q * uWall) / uTileSize;      // continuous tile coords (for derivatives)
  vec2 dx = dFdx(t0), dy = dFdy(t0);
  vec2 t = t0;
  t.x += uBrick * 0.5 * mod(floor(t.y), 2.0);
  vec2 f = fract(t);
  vec2 g = vec2(uGrout) / uTileSize * 0.5;
  vec2 d = min(f, 1.0 - f);
  bool grout = d.x < g.x || d.y < g.y;
  vec2 st = vec2(f.x, 1.0 - f.y);
  vec3 tex = textureGrad(uTile, st, vec2(dx.x, -dx.y), vec2(dy.x, -dy.y)).rgb * uBright;
  vec3 col = grout ? vec3(0.72, 0.71, 0.69) * uBright : tex;
  outColor = vec4(mix(bg.rgb, col, alpha), 1.0);
}`

type GLState = {
  gl: WebGL2RenderingContext
  prog: WebGLProgram
  bgTex: WebGLTexture
  tileTex: WebGLTexture
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error')
  return s
}

function uploadTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, src: TexImageSource, mipmaps: boolean) {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  if (mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    const ext = gl.getExtension('EXT_texture_filter_anisotropic')
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8)
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  }
}

/* ---------------------------------- helpers ---------------------------------- */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load that image.'))
    img.src = url
  })
}

/** Loads a photo and downsizes it (also applies EXIF rotation) so huge phone photos stay fast. */
async function photoToCanvas(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * scale)
    c.height = Math.round(img.naturalHeight * scale)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c
  } finally {
    URL.revokeObjectURL(url)
  }
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString()

/* ---------------------------------- component --------------------------------- */

export default function WallDesigner() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<GLState | null>(null)

  const [bg, setBg] = useState<HTMLCanvasElement | null>(null)
  const [tileImg, setTileImg] = useState<HTMLImageElement | null>(null)
  const [glReady, setGlReady] = useState(0) // bumps whenever textures/context are (re)created
  const [corners, setCorners] = useState<Pt[]>(DEFAULT_CORNERS)
  const [tile, setTile] = useState<Size>({ w: 2, h: 2 })
  const [wall, setWall] = useState<Size>({ w: 10, h: 8 })
  const [brick, setBrick] = useState(false)
  const [groutIn, setGroutIn] = useState(0.15)
  const [bright, setBright] = useState(1)
  const [guides, setGuides] = useState(true)
  const [sizeModal, setSizeModal] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // custom-size form state
  const [custom, setCustom] = useState({ w: '3', h: '1.5', unit: 'ft' as Unit })

  const tileUrlRef = useRef<string | null>(null)

  /* default tile image */
  useEffect(() => {
    let cancelled = false
    loadImage(DEFAULT_TILE_IMAGE)
      .then((img) => !cancelled && setTileImg(img))
      .catch(() => !cancelled && setError('Default tile image (/tile.jpg) not found. Use “Change tile image”.'))
    return () => {
      cancelled = true
      if (tileUrlRef.current) URL.revokeObjectURL(tileUrlRef.current)
    }
  }, [])

  /* (re)create the GL context whenever a new wall photo is set */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!bg || !canvas) return undefined
    canvas.width = bg.width
    canvas.height = bg.height
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false })
    if (!gl) {
      setError('Your browser does not support WebGL2, which the wall designer needs.')
      return undefined
    }
    try {
      const prog = gl.createProgram()!
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Could not link shader.')
      gl.useProgram(prog)

      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'a')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

      const bgTex = gl.createTexture()!
      const tileTex = gl.createTexture()!
      uploadTexture(gl, bgTex, bg, false)
      gl.viewport(0, 0, canvas.width, canvas.height)
      glRef.current = { gl, prog, bgTex, tileTex }
      setGlReady((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    }
    return () => {
      glRef.current = null
    }
  }, [bg])

  /* upload tile texture when it (or the GL context) changes */
  useEffect(() => {
    const s = glRef.current
    if (!s || !tileImg) return
    uploadTexture(s.gl, s.tileTex, tileImg, true)
    setGlReady((n) => n + 1)
  }, [tileImg, bg]) // eslint-disable-line react-hooks/exhaustive-deps

  /* draw */
  const H = useMemo(() => quadToUnitHomography(corners), [corners])

  const draw = useCallback(() => {
    const s = glRef.current
    if (!s) return
    const { gl, prog, bgTex, tileTex } = s
    gl.useProgram(prog)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, bgTex)
    gl.uniform1i(u('uBg'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, tileTex)
    gl.uniform1i(u('uTile'), 1)
    if (H) gl.uniformMatrix3fv(u('uH'), false, H)
    gl.uniform2f(u('uWall'), wall.w, wall.h)
    gl.uniform2f(u('uTileSize'), Math.max(0.05, tile.w), Math.max(0.05, tile.h))
    gl.uniform1f(u('uGrout'), groutIn / 12)
    gl.uniform1f(u('uBrick'), brick ? 1 : 0)
    gl.uniform1f(u('uBright'), bright)
    gl.uniform1f(u('uShow'), H && tileImg ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }, [H, wall, tile, groutIn, brick, bright, tileImg])

  useEffect(() => {
    draw()
  }, [draw, glReady])

  /* ------------------------------- interactions ------------------------------ */

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return setError('Please choose a photo.')
    try {
      setError(null)
      setBg(await photoToCanvas(file))
      setCorners(DEFAULT_CORNERS)
      setSizeModal(true) // ask for the tile size right away
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function onTileImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return setError('Please choose an image file.')
    const url = URL.createObjectURL(file)
    try {
      const img = await loadImage(url)
      if (tileUrlRef.current) URL.revokeObjectURL(tileUrlRef.current)
      tileUrlRef.current = url // keep alive: the <img> element is reused; revoked on replace/unmount
      setError(null)
      setTileImg(img)
    } catch (err) {
      URL.revokeObjectURL(url)
      setError((err as Error).message)
    }
  }

  function moveCorner(i: number, e: PointerEvent<HTMLButtonElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    setCorners((c) => c.map((p, k) => (k === i ? { x, y } : p)))
  }

  function applyCustom() {
    const f = UNIT_TO_FT[custom.unit]
    const w = parseFloat(custom.w) * f
    const h = parseFloat(custom.h) * f
    if (!(w > 0.05) || !(h > 0.05)) return setError('Enter a tile width and height greater than zero.')
    setError(null)
    setTile({ w, h })
    setSizeModal(false)
  }

  function canvasBlob(): Promise<Blob | null> {
    draw()
    return new Promise((res) => canvasRef.current!.toBlob(res, 'image/png'))
  }

  async function save() {
    const blob = await canvasBlob()
    if (!blob) return setError('Could not create the picture.')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'my-wall-design.png'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  async function share() {
    const blob = await canvasBlob()
    if (!blob) return
    const file = new File([blob], 'my-wall-design.png', { type: 'image/png' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My wall design' })
      } catch {
        /* user cancelled */
      }
    } else {
      save()
    }
  }

  const tilesAcross = Math.ceil(wall.w / tile.w)
  const tilesDown = Math.ceil(wall.h / tile.h)
  const sizeLabel = `${fmt(tile.w)} × ${fmt(tile.h)} ft`

  /* ----------------------------------- UI ----------------------------------- */

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-semibold text-stone-900">Wall Designer</h1>
      <p className="mt-1 text-sm text-stone-600">
        Photograph your wall, mark the area, pick a tile size and see the finished look.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {!bg && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <p className="font-medium text-stone-800">Step 1 · Add a photo of your wall or space</p>
          <p className="mt-1 text-sm text-stone-500">Stand straight in front of the wall and keep all of it in view.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="cursor-pointer rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white hover:bg-stone-700">
              Take a photo
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhoto} />
            </label>
            <label className="cursor-pointer rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100">
              Choose from gallery
              <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
            </label>
          </div>
        </div>
      )}

      {bg && (
        <>
          <div className="relative mt-5 overflow-hidden rounded-2xl border border-stone-200 bg-stone-900 shadow-sm">
            <canvas ref={canvasRef} className="block h-auto w-full" />
            {guides && (
              <div className="absolute inset-0">
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <polygon
                    points={corners.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                    fill="none"
                    stroke="white"
                    strokeWidth="0.4"
                    strokeDasharray="1.5 1"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                {corners.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Drag corner ${i + 1}`}
                    onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                    onPointerMove={(e) => moveCorner(i, e)}
                    className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-stone-900/70 shadow-lg"
                    style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                  />
                ))}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-stone-500">
            Step 2 · Drag the four corner dots onto the corners of the wall area you want to tile.
          </p>

          <section className="mt-5 space-y-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            {/* tile size */}
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-stone-500">Tile size</p>
                <p className="text-lg font-semibold text-stone-900">{sizeLabel}</p>
                <p className="text-xs text-stone-500">
                  ≈ {tilesAcross} × {tilesDown} tiles ({tilesAcross * tilesDown} total)
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTile((t) => ({ w: t.h, h: t.w }))}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
                >
                  Rotate
                </button>
                <button
                  type="button"
                  onClick={() => setSizeModal(true)}
                  className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700"
                >
                  Change size
                </button>
              </div>
            </div>

            {/* wall size */}
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-stone-500">Marked area size (feet)</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                {(['w', 'h'] as const).map((k) => (
                  <label key={k} className="text-sm text-stone-700">
                    {k === 'w' ? 'Width' : 'Height'}
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={wall[k]}
                      onChange={(e) => setWall((w) => ({ ...w, [k]: Math.max(0.5, Number(e.target.value) || 0.5) }))}
                      className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-stone-500">
                Estimate the real size of the area inside the dots (a standard door is about 7 ft tall).
              </p>
            </div>

            {/* layout */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <label className="flex items-center gap-2 text-stone-700">
                <input type="checkbox" checked={brick} onChange={(e) => setBrick(e.target.checked)} />
                Brick pattern (offset rows)
              </label>
              <label className="flex items-center gap-2 text-stone-700">
                <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
                Show corner guides
              </label>
              <label className="col-span-2 text-stone-700">
                Grout gap: {groutIn.toFixed(2)} in
                <input
                  type="range"
                  min={0}
                  max={0.75}
                  step={0.05}
                  value={groutIn}
                  onChange={(e) => setGroutIn(Number(e.target.value))}
                  className="mt-1 block w-full"
                />
              </label>
              <label className="col-span-2 text-stone-700">
                Brightness
                <input
                  type="range"
                  min={0.6}
                  max={1.3}
                  step={0.02}
                  value={bright}
                  onChange={(e) => setBright(Number(e.target.value))}
                  className="mt-1 block w-full"
                />
              </label>
            </div>

            {/* actions */}
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={save}
                className="rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white hover:bg-stone-700"
              >
                Save picture
              </button>
              <button
                type="button"
                onClick={share}
                className="rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-800 hover:bg-stone-100"
              >
                Share
              </button>
              <label className="cursor-pointer rounded-lg border border-stone-300 px-4 py-3 text-center text-sm font-medium text-stone-800 hover:bg-stone-100">
                Change tile image
                <input type="file" accept="image/*" className="hidden" onChange={onTileImage} />
              </label>
              <label className="cursor-pointer rounded-lg border border-stone-300 px-4 py-3 text-center text-sm font-medium text-stone-800 hover:bg-stone-100">
                New wall photo
                <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
              </label>
            </div>
          </section>
        </>
      )}

      {/* tile-size pop-up */}
      {sizeModal && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-900">Choose tile size</h2>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setTile(p.size)
                    setSizeModal(false)
                  }}
                  className={`rounded-xl border px-2 py-4 text-sm font-medium transition ${
                    tile.w === p.size.w && tile.h === p.size.h
                      ? 'border-stone-900 bg-stone-900 text-white'
                      : 'border-stone-300 text-stone-800 hover:bg-stone-100'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-stone-200 p-4">
              <p className="text-sm font-medium text-stone-800">Custom size</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <input
                  aria-label="Tile width"
                  inputMode="decimal"
                  value={custom.w}
                  onChange={(e) => setCustom((c) => ({ ...c, w: e.target.value }))}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
                  placeholder="Width"
                />
                <input
                  aria-label="Tile height"
                  inputMode="decimal"
                  value={custom.h}
                  onChange={(e) => setCustom((c) => ({ ...c, h: e.target.value }))}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
                  placeholder="Height"
                />
                <select
                  aria-label="Unit"
                  value={custom.unit}
                  onChange={(e) => setCustom((c) => ({ ...c, unit: e.target.value as Unit }))}
                  className="rounded-lg border border-stone-300 px-2 py-2 text-sm"
                >
                  <option value="ft">ft</option>
                  <option value="in">in</option>
                  <option value="cm">cm</option>
                </select>
              </div>
              <button
                type="button"
                onClick={applyCustom}
                className="mt-3 w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700"
              >
                Use custom size
              </button>
            </div>

            <button
              type="button"
              onClick={() => setSizeModal(false)}
              className="mt-3 w-full rounded-lg px-4 py-2 text-sm text-stone-500 hover:bg-stone-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
