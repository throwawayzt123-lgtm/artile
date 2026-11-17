'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { QRCodeSVG } from 'qrcode.react'
import { useModelViewer } from '@/lib/useModelViewer'
import CameraPreview from '@/components/CameraPreview'

const TILE = {
  name: 'Etic Pro. Eucalipto Smoked',
  size: '6x6 ft',
  finish: 'Matte',
}

// Real-world dimensions in meters (6 ft = 1.83 m)
const WIDTH = 1.83
const HEIGHT = 1.83
const THICKNESS = 0.01
const DEFAULT_TILE_IMAGE = '/tile.jpg'
const DEFAULT_TILE_GLB = '/tile.glb'
const MAX_TEXTURE_SIZE = 2048 // keeps the .glb light enough for phones

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () =>
      reject(new Error('The image could not be loaded as a texture. Please try a different file (JPG, PNG or WebP).')),
    )
  })
}

/** Builds a 1.83 x 1.83 x 0.01 m tile from an image URL and exports it as a binary GLB Blob. */
async function generateTileGlb(imageUrl: string): Promise<Blob> {
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
    return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' })
  } finally {
    texture.dispose()
    faceMaterial.dispose()
    edgeMaterial.dispose()
    geometry.dispose()
  }
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-stone-500">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-stone-300 border-t-stone-700" />
      <p className="text-sm">{label}</p>
    </div>
  )
}

export default function TileAR() {
  useModelViewer()
  const [glbUrl, setGlbUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [previewUrl, setPreviewUrl] = useState(DEFAULT_TILE_IMAGE)
  const [showCamera, setShowCamera] = useState(false)
  const previewBlobRef = useRef<string | null>(null)
  const glbUrlRef = useRef<string | null>(null)
  const jobRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null)
  const [placement, setPlacement] = useState<'wall' | 'floor'>('wall')
  const [arSupported, setArSupported] = useState<boolean | null>(null)

  const setModelUrl = useCallback((next: string | null) => {
    if (glbUrlRef.current) URL.revokeObjectURL(glbUrlRef.current)
    glbUrlRef.current = next
    setGlbUrl(next)
  }, [])

  // Revoke the last blob URL when the component unmounts.
  useEffect(
    () => () => {
      if (glbUrlRef.current) URL.revokeObjectURL(glbUrlRef.current)
      glbUrlRef.current = null
      if (previewBlobRef.current) URL.revokeObjectURL(previewBlobRef.current)
      previewBlobRef.current = null
    },
    [],
  )

  const buildModel = useCallback(
    async (imageUrl: string, { revoke }: { revoke: boolean }) => {
      const job = ++jobRef.current
      setError(null)
      setLoading(true)
      try {
        const blob = await generateTileGlb(imageUrl)
        if (job !== jobRef.current) return // a newer request superseded this one
        setModelUrl(URL.createObjectURL(blob))
      } catch (err) {
        if (job !== jobRef.current) return
        console.error(err)
        setError((err as Error)?.message || 'Something went wrong while generating the 3D model.')
      } finally {
        if (revoke) URL.revokeObjectURL(imageUrl) // texture consumed; free the image blob
        if (job === jobRef.current) setLoading(false)
      }
    },
    [setModelUrl],
  )

  const handleFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = '' // allow re-selecting the same file
      if (!file) return
      if (!file.type.startsWith('image/')) {
        setError('Please choose an image file (JPG, PNG or WebP).')
        return
      }
      // Separate URL kept for the camera-overlay preview (the one passed to buildModel is revoked after use).
      if (previewBlobRef.current) URL.revokeObjectURL(previewBlobRef.current)
      previewBlobRef.current = URL.createObjectURL(file)
      setPreviewUrl(previewBlobRef.current)
      buildModel(URL.createObjectURL(file), { revoke: true })
    },
    [buildModel],
  )

  // Load the bundled tile on startup so the AR button works immediately on any device.
  // Preferred: the pre-built /tile.glb (public https URL, which Android Scene Viewer and iOS
  // Quick Look can open). Fallback: build a model in the browser from /tile.jpg.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const glb = await fetch(DEFAULT_TILE_GLB, { method: 'HEAD' })
        const glbOk = glb.ok && !(glb.headers.get('content-type') || '').startsWith('text/')
        if (cancelled) return
        if (glbOk) {
          setModelUrl(DEFAULT_TILE_GLB)
          return
        }
        const res = await fetch(DEFAULT_TILE_IMAGE, { method: 'HEAD' })
        const isImage = res.ok && (res.headers.get('content-type') || '').startsWith('image/')
        if (!cancelled && isImage) buildModel(DEFAULT_TILE_IMAGE, { revoke: false })
      } catch {
        /* no default image: the user uploads one instead */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [buildModel, setModelUrl])

  // Detect whether this device/browser can actually launch AR.
  useEffect(() => {
    const el = viewerRef.current
    if (!el) return undefined
    const check = () => setArSupported(Boolean(el.canActivateAR))
    el.addEventListener('load', check)
    el.addEventListener('ar-status', check)
    return () => {
      el.removeEventListener('load', check)
      el.removeEventListener('ar-status', check)
    }
  }, [glbUrl, placement])

  const [pageUrl, setPageUrl] = useState('')
  useEffect(() => setPageUrl(window.location.href), [])

  return (
    <div>
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
                key={placement}
                ref={viewerRef}
                src={glbUrl}
                alt={`3D model of ${TILE.name}`}
                ar
                ar-modes="webxr scene-viewer quick-look"
                ar-placement={placement}
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
                  {placement === 'wall' ? 'View on Your Wall (AR)' : 'View on Your Floor (AR)'}
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

            {glbUrl && (
              <div className="mt-5">
                <p className="text-xs font-medium uppercase tracking-wider text-stone-500">AR placement</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(['wall', 'floor'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPlacement(p)}
                      className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition ${
                        placement === p
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-300 text-stone-700 hover:bg-stone-100'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                {arSupported === false && (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    AR isn’t available in this browser. Open this page on a phone: Chrome on Android (ARCore device)
                    or Safari on iPhone.
                  </p>
                )}
              </div>
            )}

            {glbUrl && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowCamera(true)}
                  className="w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-800 transition hover:bg-stone-100"
                >
                  Camera Preview (any phone)
                </button>
                <p className="mt-1 text-xs text-stone-500">
                  No AR support on your phone? Overlay the tile on your camera view instead.
                </p>
              </div>
            )}

            {glbUrl?.startsWith('blob:') && (
              <p className="mt-4 text-xs text-stone-500">
                Custom uploads open in AR on Chrome for Android (WebXR) and iPhone. The built-in tile works on all
                AR-capable phones.
              </p>
            )}

            {error && (
              <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Open on your phone</h2>
            <div className="mx-auto mt-4 inline-block rounded-lg border border-stone-200 bg-white p-3">
              {pageUrl && <QRCodeSVG value={pageUrl} size={196} />}
            </div>
            <p className="mt-3 text-xs text-stone-500">
              Scan to open this page on your phone, then tap the AR button under the tile.
            </p>
          </section>
        </aside>
      </main>

      {showCamera && <CameraPreview imageUrl={previewUrl} onClose={() => setShowCamera(false)} />}
    </div>
  )
}
