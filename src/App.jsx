import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import '@google/model-viewer'

const TILE = {
  name: 'Etic Pro. Eucalipto Smoked',
  size: '6x6 ft',
  finish: 'Matte',
}

// Real-world dimensions in meters (6 ft = 1.83 m)
const WIDTH = 1.83
const HEIGHT = 1.83
const THICKNESS = 0.01
const MAX_TEXTURE_SIZE = 2048 // keeps the .glb light enough for phones

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () =>
      reject(new Error('The image could not be loaded as a texture. Please try a different file (JPG, PNG or WebP).')),
    )
  })
}

/** Builds a 1.83 x 1.83 x 0.01 m tile from an image URL and exports it as a binary GLB Blob. */
async function generateTileGlb(imageUrl) {
  const texture = await loadTexture(imageUrl)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8

  const geometry = new THREE.BoxGeometry(WIDTH, HEIGHT, THICKNESS)
  // Put the back face at z = 0 so the tile sits flush on the wall when placed.
  geometry.translate(0, 0, THICKNESS / 2)

  const faceMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.85,
    metalness: 0,
  })
  const edgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xd6d3d1,
    roughness: 0.85,
    metalness: 0,
  })
  // BoxGeometry face order: +x, -x, +y, -y, +z (front), -z (back); front and back share the tile texture
  const mesh = new THREE.Mesh(geometry, [
    edgeMaterial,
    edgeMaterial,
    edgeMaterial,
    edgeMaterial,
    faceMaterial,
    faceMaterial, // back face also shows the tile design
  ])
  mesh.name = 'Tile'

  const scene = new THREE.Scene()
  scene.add(mesh)

  try {
    const exporter = new GLTFExporter()
    const result = await exporter.parseAsync(scene, {
      binary: true,
      maxTextureSize: MAX_TEXTURE_SIZE,
    })
    return new Blob([result], { type: 'model/gltf-binary' })
  } finally {
    texture.dispose()
    faceMaterial.dispose()
    edgeMaterial.dispose()
    geometry.dispose()
  }
}

function Spinner({ label }) {
  return (
    <div className="flex flex-col items-center gap-4 text-stone-500">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-stone-300 border-t-stone-700" />
      <p className="text-sm">{label}</p>
    </div>
  )
}

export default function App() {
  const [glbUrl, setGlbUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const glbUrlRef = useRef(null)
  const jobRef = useRef(0)
  const fileInputRef = useRef(null)

  const setModelUrl = useCallback((next) => {
    if (glbUrlRef.current) URL.revokeObjectURL(glbUrlRef.current)
    glbUrlRef.current = next
    setGlbUrl(next)
  }, [])

  // Revoke the last blob URL when the component unmounts.
  useEffect(
    () => () => {
      if (glbUrlRef.current) URL.revokeObjectURL(glbUrlRef.current)
      glbUrlRef.current = null
    },
    [],
  )

  const handleFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0]
      event.target.value = '' // allow re-selecting the same file
      if (!file) return

      if (!file.type.startsWith('image/')) {
        setError('Please choose an image file (JPG, PNG or WebP).')
        return
      }

      const job = ++jobRef.current
      setError(null)
      setLoading(true)

      const imageUrl = URL.createObjectURL(file)
      try {
        const blob = await generateTileGlb(imageUrl)
        if (job !== jobRef.current) return // a newer upload superseded this one
        setModelUrl(URL.createObjectURL(blob))
      } catch (err) {
        if (job !== jobRef.current) return
        console.error(err)
        setError(err?.message || 'Something went wrong while generating the 3D model.')
      } finally {
        URL.revokeObjectURL(imageUrl) // the texture has been consumed; free the image blob
        if (job === jobRef.current) setLoading(false)
      }
    },
    [setModelUrl],
  )

  const pageUrl = typeof window !== 'undefined' ? window.location.href : ''
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(pageUrl)}`

  return (
    <div className="min-h-screen bg-stone-100 text-stone-800">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-500">AR Tile Visualizer</p>
          <h1 className="mt-1 text-2xl font-semibold text-stone-900 sm:text-3xl">{TILE.name}</h1>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <span className="rounded-full bg-stone-100 px-3 py-1 text-stone-700">Size: {TILE.size}</span>
            <span className="rounded-full bg-stone-100 px-3 py-1 text-stone-700">Finish: {TILE.finish}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Left: viewer */}
        <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
          <div className="relative flex aspect-square w-full items-center justify-center bg-stone-50 sm:aspect-[4/3]">
            {loading ? (
              <Spinner label="Generating 3D model…" />
            ) : glbUrl ? (
              <model-viewer
                src={glbUrl}
                alt={`3D model of ${TILE.name}`}
                ar
                ar-modes="webxr scene-viewer quick-look"
                ar-placement="wall"
                ar-scale="fixed"
                camera-controls
                touch-action="pan-y"
                shadow-intensity="1"
                style={{ width: '100%', height: '100%', backgroundColor: '#fafaf9' }}
              >
                <button
                  slot="ar-button"
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white shadow-lg transition hover:bg-stone-700"
                >
                  View on Your Wall (AR)
                </button>
              </model-viewer>
            ) : (
              <div className="max-w-xs px-6 text-center text-stone-500">
                <div className="mx-auto mb-4 h-16 w-16 rounded-lg border-2 border-dashed border-stone-300" />
                <p className="font-medium text-stone-700">No tile loaded yet</p>
                <p className="mt-1 text-sm">Upload a photo of the tile to preview it in 3D and on your wall.</p>
              </div>
            )}
          </div>
        </section>

        {/* Right: controls */}
        <aside className="flex flex-col gap-6">
          <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Your Tile</h2>

            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className="mt-4 w-full rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {glbUrl ? 'Choose Another Image' : 'Choose Image File'}
            </button>

            {glbUrl && (
              <a
                href={glbUrl}
                download="etic-pro-eucalipto-smoked.glb"
                className="mt-3 block w-full rounded-lg border border-stone-300 px-4 py-3 text-center text-sm font-medium text-stone-800 transition hover:bg-stone-100"
              >
                Download .glb
              </a>
            )}

            {error && (
              <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Open on your phone</h2>
            <img
              src={qrSrc}
              alt="QR code linking to this page"
              width={220}
              height={220}
              className="mx-auto mt-4 rounded-lg border border-stone-200"
            />
            <p className="mt-3 text-xs text-stone-500">
              Scan to open this page on your phone, then tap “View on Your Wall (AR)”.
            </p>
          </section>
        </aside>
      </main>
    </div>
  )
}
