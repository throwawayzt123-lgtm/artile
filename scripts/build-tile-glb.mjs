// Builds public/tile.glb from public/tile.jpg (no browser needed).
// Output: 1.83 x 1.83 x 0.01 m box, back face at z=0, tile image on front AND back, matte (roughness .85).
// Runs automatically before `npm run build` (see "prebuild" in package.json).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imgPath = path.join(root, 'public', 'tile.jpg')
const outPath = path.join(root, 'public', 'tile.glb')

if (!existsSync(imgPath)) {
  console.warn('[tile-glb] public/tile.jpg not found - skipping tile.glb generation')
  process.exit(0)
}

const image = readFileSync(imgPath)
const isPng = image[0] === 0x89 && image[1] === 0x50
const mimeType = isPng ? 'image/png' : 'image/jpeg'

const W = 1.83 / 2
const H = 1.83 / 2
const T = 0.01

// Each quad: 4 corners [x,y,z], outward normal, optional uvs. Winding is auto-fixed to CCW from outside.
const faces = [
  { n: [0, 0, 1], tex: true, p: [[-W, -H, T], [W, -H, T], [W, H, T], [-W, H, T]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { n: [0, 0, -1], tex: true, p: [[W, -H, 0], [-W, -H, 0], [-W, H, 0], [W, H, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { n: [0, 1, 0], p: [[-W, H, 0], [W, H, 0], [W, H, T], [-W, H, T]] },
  { n: [0, -1, 0], p: [[-W, -H, 0], [W, -H, 0], [W, -H, T], [-W, -H, T]] },
  { n: [1, 0, 0], p: [[W, -H, 0], [W, H, 0], [W, H, T], [W, -H, T]] },
  { n: [-1, 0, 0], p: [[-W, -H, 0], [-W, H, 0], [-W, H, T], [-W, -H, T]] },
]

const pos = []
const nor = []
const uvs = []
const texIdx = []
const edgeIdx = []
let v = 0
for (const f of faces) {
  let order = [0, 1, 2, 3]
  const [a, b, c] = f.p
  const e1 = b.map((x, i) => x - a[i])
  const e2 = c.map((x, i) => x - a[i])
  const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  if (cross[0] * f.n[0] + cross[1] * f.n[1] + cross[2] * f.n[2] < 0) order = [0, 3, 2, 1]
  for (const i of order) {
    pos.push(...f.p[i])
    nor.push(...f.n)
    uvs.push(...(f.uv ? f.uv[i] : [0, 0]))
  }
  ;(f.tex ? texIdx : edgeIdx).push(v, v + 1, v + 2, v, v + 2, v + 3)
  v += 4
}

const pad4 = (len) => (4 - (len % 4)) % 4
const chunks = []
const views = []
let offset = 0
function addView(buf, target) {
  const view = { buffer: 0, byteOffset: offset, byteLength: buf.byteLength }
  if (target) view.target = target
  views.push(view)
  const padded = Buffer.concat([buf, Buffer.alloc(pad4(buf.byteLength))])
  chunks.push(padded)
  offset += padded.byteLength
  return views.length - 1
}

const f32 = (a) => Buffer.from(new Float32Array(a).buffer)
const u16 = (a) => Buffer.from(new Uint16Array(a).buffer)

const vPos = addView(f32(pos), 34962)
const vNor = addView(f32(nor), 34962)
const vUv = addView(f32(uvs), 34962)
const vTexIdx = addView(u16(texIdx), 34963)
const vEdgeIdx = addView(u16(edgeIdx), 34963)
const vImg = addView(image)

const count = pos.length / 3
const min = [-W, -H, 0]
const max = [W, H, T]

const gltf = {
  asset: { version: '2.0', generator: 'ar-tile build script' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'Tile' }],
  meshes: [
    {
      name: 'Tile',
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
        { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 4, material: 1 },
      ],
    },
  ],
  materials: [
    { name: 'TileFace', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 } },
    { name: 'TileEdge', pbrMetallicRoughness: { baseColorFactor: [0.84, 0.83, 0.82, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
  ],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  images: [{ bufferView: vImg, mimeType }],
  accessors: [
    { bufferView: vPos, componentType: 5126, count, type: 'VEC3', min, max },
    { bufferView: vNor, componentType: 5126, count, type: 'VEC3' },
    { bufferView: vUv, componentType: 5126, count, type: 'VEC2' },
    { bufferView: vTexIdx, componentType: 5123, count: texIdx.length, type: 'SCALAR' },
    { bufferView: vEdgeIdx, componentType: 5123, count: edgeIdx.length, type: 'SCALAR' },
  ],
  bufferViews: views,
  buffers: [{ byteLength: offset }],
}

const bin = Buffer.concat(chunks)
let json = Buffer.from(JSON.stringify(gltf), 'utf8')
json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)])

const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0) // 'glTF'
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
const jsonHead = Buffer.alloc(8)
jsonHead.writeUInt32LE(json.length, 0)
jsonHead.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
const binHead = Buffer.alloc(8)
binHead.writeUInt32LE(bin.length, 0)
binHead.writeUInt32LE(0x004e4942, 4) // 'BIN\0'

writeFileSync(outPath, Buffer.concat([header, jsonHead, json, binHead, bin]))
console.log(`[tile-glb] wrote public/tile.glb (${((12 + 16 + json.length + bin.length) / 1024).toFixed(0)} KB)`)
