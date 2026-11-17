'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent } from 'react'

/* ================================ types & consts ================================ */

type Pt = { x: number; y: number } // normalized 0..1, origin top-left of the photo
type Size = { w: number; h: number } // always stored in feet
type Unit = 'ft' | 'in' | 'cm' | 'm'

type TileDesign = { id: string; name: string; url: string; img: HTMLImageElement | null }

type Area = {
  id: string
  name: string
  corners: Pt[] // TL, TR, BR, BL
  wall: Size // real size of the marked area (ft)
  tile: Size // tile size (ft)
  tileId: string
  brick: boolean
  groutIn: number // grout width in inches
  grout: string // grout colour hex
}

const UNIT_TO_FT: Record<Unit, number> = { ft: 1, in: 1 / 12, cm: 1 / 30.48, m: 1 / 0.3048 }
const MAX_PHOTO_SIDE = 2048

const TILE_PRESETS: { label: string; size: Size }[] = [
  { label: '2 × 2 ft', size: { w: 2, h: 2 } },
  { label: '4 × 2 ft', size: { w: 4, h: 2 } },
  { label: '2 × 4 ft', size: { w: 2, h: 4 } },
  { label: '6 × 6 ft', size: { w: 6, h: 6 } },
]

const GROUT_COLORS = [
  { name: 'White', hex: '#e9e7e2' },
  { name: 'Grey', hex: '#8f8c87' },
  { name: 'Charcoal', hex: '#3a3936' },
  { name: 'Black', hex: '#141414' },
]

const AREA_COLORS = ['#ffffff', '#facc15', '#38bdf8', '#f472b6', '#4ade80']

const DEFAULT_TILES: TileDesign[] = [{ id: 'default', name: 'Eucalipto Smoked', url: '/tile.jpg', img: null }]

const uid = () => Math.random().toString(36).slice(2, 9)
const fmt = (n: number) => (Math.round(n * 100) / 100).toString()

function defaultCorners(index: number): Pt[] {
  // stagger new areas so they don't sit exactly on top of each other
  const o = Math.min(index * 0.06, 0.24)
  return [
    { x: 0.12 + o, y: 0.15 + o },
    { x: 0.88 - o, y: 0.15 + o },
    { x: 0.88 - o, y: 0.8 - o / 2 },
    { x: 0.12 + o, y: 0.8 - o / 2 },
  ]
}

/* ================================== homography ================================= */

/** 3x3 projective transform (row-major) mapping the quad -> unit square, or null if degenerate. */
function quadToUnit(q: Pt[]): number[] | null {
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
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
  const cx = q.reduce((s, p) => s + p.x, 0) / 4
  const cy = q.reduce((s, p) => s + p.y, 0) / 4
  const w = H[6] * cx + H[7] * cy + H[8]
  return w < 0 ? H.map((n) => -n) : H
}

const toColumnMajor = (H: number[]) => new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]])

function applyH(H: number[], x: number, y: number) {
  const w = H[6] * x + H[7] * y + H[8]
  return { u: (H[0] * x + H[1] * y + H[2]) / w, v: (H[3] * x + H[4] * y + H[5]) / w, w }
}

/* ===================================== WebGL ==================================== */

const VERT = `#version 300 es
in vec2 a;
out vec2 vUv;
void main(){ vUv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform int uPass;          // 0 = photo, 1 = tiled area
uniform sampler2D uBg;
uniform sampler2D uTile;
uniform mat3 uH;
uniform vec2 uWall;         // ft
uniform vec2 uTileSize;     // ft
uniform float uGrout;       // ft
uniform vec3 uGroutColor;
uniform float uBrick;
uniform float uBright;
uniform float uLight;       // 0..1 how much of the photo's lighting is transferred
uniform float uAvgLum;      // average (blurred) luminance inside the area
uniform float uBlurLod;
void main(){
  if (uPass == 0) { outColor = vec4(texture(uBg, vUv).rgb, 1.0); return; }

  vec2 n = vec2(vUv.x, 1.0 - vUv.y);
  vec3 p = uH * vec3(n, 1.0);
  if (p.z <= 0.0) discard;
  vec2 q = p.xy / p.z;
  float fw = max(fwidth(q.x), fwidth(q.y));
  float edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
  float alpha = smoothstep(-fw, fw, edge);
  if (alpha <= 0.0) discard;

  vec2 t0 = (q * uWall) / uTileSize;
  vec2 dx = dFdx(t0), dy = dFdy(t0);
  vec2 t = t0;
  t.x += uBrick * 0.5 * mod(floor(t.y), 2.0);
  vec2 f = fract(t);
  vec2 g = vec2(uGrout) / uTileSize * 0.5;
  vec2 d = min(f, 1.0 - f);
  // soft grout edge (avoids jaggies on thin lines)
  vec2 gfw = max(fwidth(t), vec2(1e-5));
  float gx = 1.0 - smoothstep(g.x - gfw.x * 0.5, g.x + gfw.x * 0.5, d.x);
  float gy = 1.0 - smoothstep(g.y - gfw.y * 0.5, g.y + gfw.y * 0.5, d.y);
  float groutAmt = (uGrout > 0.0) ? max(gx, gy) : 0.0;

  vec3 tex = textureGrad(uTile, vec2(f.x, 1.0 - f.y), vec2(dx.x, -dx.y), vec2(dy.x, -dy.y)).rgb;
  vec3 col = mix(tex, uGroutColor, groutAmt);

  // Transfer the room's lighting (lamp hotspots, shadows, falloff) from the photo onto the tiles.
  vec3 blur = textureLod(uBg, vUv, uBlurLod).rgb;
  float l = dot(blur, vec3(0.2126, 0.7152, 0.0722));
  float shade = clamp(l / max(uAvgLum, 0.03), 0.3, 1.9);
  col *= mix(1.0, shade, uLight) * uBright;

  outColor = vec4(col, alpha);
}`

type GLState = {
  gl: WebGL2RenderingContext
  prog: WebGLProgram
  bgTex: WebGLTexture
  tileTex: Map<string, WebGLTexture>
  blurLod: number
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'Shader error')
  return s
}

function uploadTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, src: TexImageSource) {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  const ext = gl.getExtension('EXT_texture_filter_anisotropic')
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8)
}

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const
}

/* ==================================== helpers =================================== */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load that image.'))
    img.src = url
  })
}

/** Loads a photo (EXIF rotation applied by the browser) and downsizes huge phone photos. */
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

/** Small blurred copy of the photo used to measure the average brightness of each area. */
function makeLumaGrid(bg: HTMLCanvasElement) {
  const W = 64
  const H = Math.max(1, Math.round((bg.height / bg.width) * W))
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.drawImage(bg, 0, 0, W, H)
  const d = ctx.getImageData(0, 0, W, H).data
  const lum = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) lum[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255
  return { W, H, lum }
}

function areaAvgLum(grid: ReturnType<typeof makeLumaGrid>, H: number[]) {
  let sum = 0
  let n = 0
  for (let y = 0; y < grid.H; y++)
    for (let x = 0; x < grid.W; x++) {
      const { u, v, w } = applyH(H, (x + 0.5) / grid.W, (y + 0.5) / grid.H)
      if (w > 0 && u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        sum += grid.lum[y * grid.W + x]
        n++
      }
    }
  return n ? sum / n : 0.5
}

/** Size input that accepts free typing (fixes the old "snaps to 0.5" bug). */
function NumField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="text-sm text-stone-700">
      {label}
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        onFocus={(e) => e.target.select()}
        className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-base"
      />
    </label>
  )
}

/* =================================== component ================================== */

export default function WallDesigner() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<GLState | null>(null)
  const lumaRef = useRef<ReturnType<typeof makeLumaGrid> | null>(null)
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const blobUrls = useRef<string[]>([])

  const [bg, setBg] = useState<HTMLCanvasElement | null>(null)
  const [tiles, setTiles] = useState<TileDesign[]>(DEFAULT_TILES)
  const [areas, setAreas] = useState<Area[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [light, setLight] = useState(0.75)
  const [bright, setBright] = useState(1)
  const [guides, setGuides] = useState(true)
  const [glTick, setGlTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<{ i: number; x: number; y: number } | null>(null)

  // dialog state (editing one area)
  const [dialog, setDialog] = useState<null | {
    areaId: string
    isNew: boolean
    unit: Unit
    wallW: string
    wallH: string
    tileUnit: Unit
    tileW: string
    tileH: string
    tileId: string
  }>(null)

  const active = areas.find((a) => a.id === activeId) ?? null

  /* ---------- load tile images ---------- */
  useEffect(() => {
    tiles.forEach((t) => {
      if (t.img) return
      loadImage(t.url)
        .then((img) => setTiles((all) => all.map((x) => (x.id === t.id ? { ...x, img } : x))))
        .catch(() => setError(`Could not load tile image “${t.name}”.`))
    })
  }, [tiles])

  useEffect(() => () => blobUrls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  /* ---------- GL setup per photo ---------- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!bg || !canvas) return undefined
    canvas.width = bg.width
    canvas.height = bg.height
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false })
    if (!gl) {
      setError('This browser does not support WebGL2, which the wall designer needs.')
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
      uploadTexture(gl, bgTex, bg)
      gl.viewport(0, 0, canvas.width, canvas.height)
      const blurLod = Math.max(0, Math.log2(Math.max(bg.width, bg.height) / 40))
      glRef.current = { gl, prog, bgTex, tileTex: new Map(), blurLod }
      lumaRef.current = makeLumaGrid(bg)
      setGlTick((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    }
    return () => {
      glRef.current = null
    }
  }, [bg])

  /* ---------- draw ---------- */
  const draw = useCallback(() => {
    const s = glRef.current
    if (!s) return
    const { gl, prog } = s
    const u = (n: string) => gl.getUniformLocation(prog, n)
    gl.useProgram(prog)

    gl.disable(gl.BLEND)
    gl.uniform1i(u('uPass'), 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, s.bgTex)
    gl.uniform1i(u('uBg'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform1i(u('uPass'), 1)
    gl.uniform1f(u('uLight'), light)
    gl.uniform1f(u('uBright'), bright)
    gl.uniform1f(u('uBlurLod'), s.blurLod)

    for (const area of areas) {
      const design = tiles.find((t) => t.id === area.tileId)
      if (!design?.img) continue
      let tex = s.tileTex.get(design.id)
      if (!tex) {
        tex = gl.createTexture()!
        uploadTexture(gl, tex, design.img)
        s.tileTex.set(design.id, tex)
      }
      const H = quadToUnit(area.corners)
      if (!H) continue
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(u('uTile'), 1)
      gl.uniformMatrix3fv(u('uH'), false, toColumnMajor(H))
      gl.uniform2f(u('uWall'), area.wall.w, area.wall.h)
      gl.uniform2f(u('uTileSize'), Math.max(0.05, area.tile.w), Math.max(0.05, area.tile.h))
      gl.uniform1f(u('uGrout'), area.groutIn / 12)
      gl.uniform3f(u('uGroutColor'), ...hexToRgb(area.grout))
      gl.uniform1f(u('uBrick'), area.brick ? 1 : 0)
      gl.uniform1f(u('uAvgLum'), lumaRef.current ? areaAvgLum(lumaRef.current, H) : 0.5)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }, [areas, tiles, light, bright])

  useEffect(() => {
    draw()
  }, [draw, glTick])

  /* ---------- area helpers ---------- */
  const updateArea = (id: string, patch: Partial<Area>) =>
    setAreas((all) => all.map((a) => (a.id === id ? { ...a, ...patch } : a)))

  function openDialog(area: Area, isNew: boolean) {
    setDialog({
      areaId: area.id,
      isNew,
      unit: 'ft',
      wallW: fmt(area.wall.w),
      wallH: fmt(area.wall.h),
      tileUnit: 'ft',
      tileW: fmt(area.tile.w),
      tileH: fmt(area.tile.h),
      tileId: area.tileId,
    })
  }

  function addArea() {
    const prev = areas[areas.length - 1]
    const area: Area = {
      id: uid(),
      name: `Wall ${areas.length + 1}`,
      corners: defaultCorners(areas.length),
      wall: prev ? { ...prev.wall } : { w: 16, h: 12 },
      tile: prev ? { ...prev.tile } : { w: 2, h: 2 },
      tileId: prev?.tileId ?? tiles[0].id,
      brick: false,
      groutIn: 0.12,
      grout: GROUT_COLORS[1].hex,
    }
    setAreas((all) => [...all, area])
    setActiveId(area.id)
    openDialog(area, true)
  }

  function removeArea(id: string) {
    setAreas((all) => {
      const rest = all.filter((a) => a.id !== id).map((a, i) => ({ ...a, name: `Wall ${i + 1}` }))
      setActiveId(rest[rest.length - 1]?.id ?? null)
      return rest
    })
  }

  function saveDialog() {
    if (!dialog) return
    const wf = UNIT_TO_FT[dialog.unit]
    const tf = UNIT_TO_FT[dialog.tileUnit]
    const wall = { w: parseFloat(dialog.wallW) * wf, h: parseFloat(dialog.wallH) * wf }
    const tile = { w: parseFloat(dialog.tileW) * tf, h: parseFloat(dialog.tileH) * tf }
    if (!(wall.w > 0) || !(wall.h > 0)) return setError('Enter the wall width and height.')
    if (!(tile.w > 0.04) || !(tile.h > 0.04)) return setError('Enter a tile width and height.')
    if (tile.w > wall.w * 2 || tile.h > wall.h * 2) return setError('The tile is bigger than the wall. Check the units.')
    setError(null)
    updateArea(dialog.areaId, { wall, tile, tileId: dialog.tileId })
    setDialog(null)
  }

  function cancelDialog() {
    if (dialog?.isNew) removeArea(dialog.areaId)
    setDialog(null)
  }

  /* ---------- photo & tile uploads ---------- */
  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return setError('Please choose a photo.')
    try {
      setError(null)
      setBg(await photoToCanvas(file))
      setAreas([])
      setActiveId(null)
      // first wall is created right after the photo, and its settings pop up
      setTimeout(() => addAreaRef.current(), 0)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const addAreaRef = useRef(addArea)
  addAreaRef.current = addArea

  async function onTileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return setError('Please choose an image file.')
    const url = URL.createObjectURL(file)
    blobUrls.current.push(url)
    const id = uid()
    const name = file.name.replace(/\.\w+$/, '').slice(0, 24) || 'My tile'
    setTiles((all) => [...all, { id, name, url, img: null }])
    setDialog((d) => (d ? { ...d, tileId: id } : d))
  }

  /* ---------- corner dragging with magnifier ---------- */
  function onCornerMove(i: number, e: PointerEvent<HTMLButtonElement>) {
    if (!active || !e.currentTarget.hasPointerCapture(e.pointerId)) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    updateArea(active.id, { corners: active.corners.map((p, k) => (k === i ? { x, y } : p)) })
    setDragging({ i, x, y })
    drawLoupe(x, y)
  }

  function drawLoupe(x: number, y: number) {
    const lc = loupeRef.current
    if (!lc || !bg) return
    const ctx = lc.getContext('2d')!
    const S = lc.width
    const src = 60 * (bg.width / 1000) // source window (photo px) scales with photo size
    ctx.clearRect(0, 0, S, S)
    ctx.drawImage(bg, x * bg.width - src / 2, y * bg.height - src / 2, src, src, 0, 0, S, S)
    ctx.strokeStyle = '#ff2d55'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(S / 2, 0)
    ctx.lineTo(S / 2, S)
    ctx.moveTo(0, S / 2)
    ctx.lineTo(S, S / 2)
    ctx.stroke()
  }

  /* ---------- export ---------- */
  function canvasBlob(): Promise<Blob | null> {
    draw()
    return new Promise((res) => canvasRef.current!.toBlob(res, 'image/jpeg', 0.92))
  }
  async function save() {
    const blob = await canvasBlob()
    if (!blob) return setError('Could not create the picture.')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'my-wall-design.jpg'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  async function share() {
    const blob = await canvasBlob()
    if (!blob) return
    const file = new File([blob], 'my-wall-design.jpg', { type: 'image/jpeg' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My wall design' })
      } catch {
        /* cancelled */
      }
    } else save()
  }

  const count = (a: Area) => ({ x: Math.ceil(a.wall.w / a.tile.w - 1e-6), y: Math.ceil(a.wall.h / a.tile.h - 1e-6) })

  /* ====================================== UI ====================================== */

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-semibold text-stone-900">Wall Designer</h1>
      <p className="mt-1 text-sm text-stone-600">
        Photograph your space, mark each wall, choose tiles and save the finished look.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {!bg && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <p className="font-medium text-stone-800">Step 1 · Add a photo of your wall or room</p>
          <p className="mt-1 text-sm text-stone-500">Stand back so the whole wall (all four corners) is in the photo.</p>
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
          {/* ---------- canvas + handles ---------- */}
          <div className="relative mt-5 select-none px-3 py-3">
            <canvas ref={canvasRef} className="block h-auto w-full rounded-xl shadow-sm" />
            {guides && (
              <div className="pointer-events-none absolute inset-3">
                <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {areas.map((a, idx) => (
                    <polygon
                      key={a.id}
                      points={a.corners.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                      fill="none"
                      stroke={AREA_COLORS[idx % AREA_COLORS.length]}
                      strokeWidth={a.id === activeId ? 2 : 1}
                      strokeDasharray={a.id === activeId ? '6 4' : '3 3'}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                {active &&
                  active.corners.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label={`Drag corner ${i + 1} of ${active.name}`}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId)
                        setDragging({ i, x: p.x, y: p.y })
                        drawLoupe(p.x, p.y)
                      }}
                      onPointerMove={(e) => onCornerMove(i, e)}
                      onPointerUp={() => setDragging(null)}
                      onPointerCancel={() => setDragging(null)}
                      className="pointer-events-auto absolute h-9 w-9 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-[3px] border-white bg-stone-900/40 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                    >
                      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
                    </button>
                  ))}

                {/* magnifier shown above the finger while dragging */}
                <canvas
                  ref={loupeRef}
                  width={120}
                  height={120}
                  className={`absolute h-[120px] w-[120px] -translate-x-1/2 rounded-full border-4 border-white shadow-xl ${
                    dragging ? 'block' : 'hidden'
                  }`}
                  style={
                    dragging
                      ? {
                          left: `${dragging.x * 100}%`,
                          top: `calc(${dragging.y * 100}% - ${dragging.y < 0.3 ? -90 : 90}px)`,
                          transform: 'translate(-50%, -50%)',
                        }
                      : undefined
                  }
                />
              </div>
            )}
          </div>
          <p className="px-3 text-xs text-stone-500">
            Drag the four dots of the selected wall onto its real corners. A magnifier appears while you drag.
          </p>

          {/* ---------- walls / areas ---------- */}
          <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              {areas.map((a, idx) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setActiveId(a.id)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    a.id === activeId ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 text-stone-700 hover:bg-stone-100'
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full border border-black/30"
                    style={{ backgroundColor: AREA_COLORS[idx % AREA_COLORS.length] }}
                  />
                  {a.name}
                </button>
              ))}
              <button
                type="button"
                onClick={addArea}
                className="rounded-full border border-dashed border-stone-400 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                + Add wall / area
              </button>
            </div>

            {active && (
              <div className="mt-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={tiles.find((t) => t.id === active.tileId)?.url}
                      alt=""
                      className="h-14 w-14 rounded-lg border border-stone-200 object-cover"
                    />
                    <div className="text-sm">
                      <p className="font-semibold text-stone-900">
                        {active.name}: {fmt(active.wall.w)} × {fmt(active.wall.h)} ft
                      </p>
                      <p className="text-stone-600">
                        Tile {fmt(active.tile.w)} × {fmt(active.tile.h)} ft · {tiles.find((t) => t.id === active.tileId)?.name}
                      </p>
                      <p className="text-stone-500">
                        {count(active).x} × {count(active).y} = {count(active).x * count(active).y} tiles
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => openDialog(active, false)}
                      className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700"
                    >
                      Size &amp; tile
                    </button>
                    <button
                      type="button"
                      onClick={() => updateArea(active.id, { tile: { w: active.tile.h, h: active.tile.w } })}
                      className="rounded-lg border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
                    >
                      Rotate tile
                    </button>
                    <button
                      type="button"
                      onClick={() => removeArea(active.id)}
                      className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-stone-700">
                    Grout gap: {active.groutIn.toFixed(2)} in
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.02}
                      value={active.groutIn}
                      onChange={(e) => updateArea(active.id, { groutIn: Number(e.target.value) })}
                      className="mt-1 block w-full"
                    />
                  </label>
                  <div className="text-sm text-stone-700">
                    Grout colour
                    <div className="mt-1 flex gap-2">
                      {GROUT_COLORS.map((g) => (
                        <button
                          key={g.hex}
                          type="button"
                          title={g.name}
                          aria-label={`${g.name} grout`}
                          onClick={() => updateArea(active.id, { grout: g.hex })}
                          className={`h-8 w-8 rounded-full border-2 ${
                            active.grout === g.hex ? 'border-stone-900 ring-2 ring-stone-900 ring-offset-1' : 'border-stone-300'
                          }`}
                          style={{ backgroundColor: g.hex }}
                        />
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={active.brick}
                      onChange={(e) => updateArea(active.id, { brick: e.target.checked })}
                    />
                    Brick pattern (offset rows)
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* ---------- look & export ---------- */}
          <section className="mt-5 space-y-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-stone-700">
                Match room lighting
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={light}
                  onChange={(e) => setLight(Number(e.target.value))}
                  className="mt-1 block w-full"
                />
              </label>
              <label className="text-sm text-stone-700">
                Brightness
                <input
                  type="range"
                  min={0.6}
                  max={1.4}
                  step={0.02}
                  value={bright}
                  onChange={(e) => setBright(Number(e.target.value))}
                  className="mt-1 block w-full"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
                Show outlines &amp; corner dots
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
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
                New photo
                <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
              </label>
            </div>
          </section>
        </>
      )}

      {/* ---------- size & tile pop-up ---------- */}
      {dialog && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-3 sm:items-center">
          <div role="dialog" aria-modal="true" className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-900">
              {areas.find((a) => a.id === dialog.areaId)?.name ?? 'Wall'} setup
            </h2>

            {/* wall size */}
            <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-stone-500">1 · Real size of this wall / area</p>
            <div className="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <NumField label="Width" value={dialog.wallW} onChange={(v) => setDialog({ ...dialog, wallW: v })} />
              <NumField label="Height" value={dialog.wallH} onChange={(v) => setDialog({ ...dialog, wallH: v })} />
              <select
                aria-label="Wall unit"
                value={dialog.unit}
                onChange={(e) => setDialog({ ...dialog, unit: e.target.value as Unit })}
                className="rounded-lg border border-stone-300 px-2 py-2 text-base"
              >
                <option value="ft">ft</option>
                <option value="in">in</option>
                <option value="m">m</option>
                <option value="cm">cm</option>
              </select>
            </div>
            <p className="mt-1 text-xs text-stone-500">Measure it if you can. Tile count and size depend on this.</p>

            {/* tile size */}
            <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-stone-500">2 · Tile size</p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {TILE_PRESETS.map((p) => {
                const on =
                  dialog.tileUnit === 'ft' &&
                  parseFloat(dialog.tileW) === p.size.w &&
                  parseFloat(dialog.tileH) === p.size.h
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() =>
                      setDialog({ ...dialog, tileUnit: 'ft', tileW: String(p.size.w), tileH: String(p.size.h) })
                    }
                    className={`rounded-lg border px-1 py-3 text-xs font-medium ${
                      on ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 text-stone-800 hover:bg-stone-100'
                    }`}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <NumField label="Custom width" value={dialog.tileW} onChange={(v) => setDialog({ ...dialog, tileW: v })} />
              <NumField label="Custom height" value={dialog.tileH} onChange={(v) => setDialog({ ...dialog, tileH: v })} />
              <select
                aria-label="Tile unit"
                value={dialog.tileUnit}
                onChange={(e) => setDialog({ ...dialog, tileUnit: e.target.value as Unit })}
                className="rounded-lg border border-stone-300 px-2 py-2 text-base"
              >
                <option value="ft">ft</option>
                <option value="in">in</option>
                <option value="cm">cm</option>
                <option value="m">m</option>
              </select>
            </div>

            {/* tile design */}
            <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-stone-500">3 · Tile design</p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {tiles.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setDialog({ ...dialog, tileId: t.id })}
                  className={`overflow-hidden rounded-lg border-2 text-left ${
                    dialog.tileId === t.id ? 'border-stone-900' : 'border-transparent'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.url} alt={t.name} className="aspect-square w-full object-cover" />
                  <span className="block truncate px-1 py-0.5 text-[10px] text-stone-600">{t.name}</span>
                </button>
              ))}
              <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-stone-300 text-center text-[11px] text-stone-600 hover:bg-stone-50">
                <span className="text-xl leading-none">+</span>
                Upload tile
                <input type="file" accept="image/*" className="hidden" onChange={onTileUpload} />
              </label>
            </div>

            {(() => {
              const wf = UNIT_TO_FT[dialog.unit]
              const tf = UNIT_TO_FT[dialog.tileUnit]
              const nx = Math.ceil((parseFloat(dialog.wallW) * wf) / (parseFloat(dialog.tileW) * tf) - 1e-6)
              const ny = Math.ceil((parseFloat(dialog.wallH) * wf) / (parseFloat(dialog.tileH) * tf) - 1e-6)
              return Number.isFinite(nx) && Number.isFinite(ny) && nx > 0 && ny > 0 ? (
                <p className="mt-4 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">
                  {nx} across × {ny} down = <strong>{nx * ny} tiles</strong>
                </p>
              ) : null
            })()}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={cancelDialog} className="rounded-lg px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-100">
                Cancel
              </button>
              <button
                type="button"
                onClick={saveDialog}
                className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
