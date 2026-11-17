'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import CarModelViewer from '@/components/CarModelViewer'
import { findCar } from '@/lib/cars'
import type { ShowroomCar } from '@/lib/cars'

const VIEWS = [
  { key: 'front', label: 'Front' },
  { key: 'back', label: 'Back' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
] as const
type ViewKey = (typeof VIEWS)[number]['key']

const MAX_DIMENSION = 1280

/** Downscale photos in the browser so all 4 fit under serverless request limits. */
async function shrinkImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
  if (!blob) throw new Error('Could not process image.')
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
}

export default function CarPage() {
  const [files, setFiles] = useState<Partial<Record<ViewKey, File>>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelUrl, setModelUrl] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')
  const [isDesktop, setIsDesktop] = useState(false)
  const [demo, setDemo] = useState(false)
  const [car, setCar] = useState<ShowroomCar | null>(null)
  const [colorId, setColorId] = useState('original')
  const [progress, setProgress] = useState(0)

  // Preview URLs, revoked whenever the selection changes or on unmount.
  const previews = useMemo(
    () =>
      Object.fromEntries(Object.entries(files).map(([k, f]) => [k, URL.createObjectURL(f)])) as Record<
        string,
        string
      >,
    [files],
  )
  useEffect(() => () => Object.values(previews).forEach((u) => URL.revokeObjectURL(u)), [previews])

  useEffect(() => {
    setOrigin(window.location.origin)
    setIsDesktop(window.matchMedia('(hover: hover) and (pointer: fine)').matches)

    const params = new URLSearchParams(window.location.search)

    // Showroom car: /car?car=bugatti-chiron&color=red
    const showroom = findCar(params.get('car'))
    if (showroom) {
      setCar(showroom)
      setModelUrl(showroom.src)
      const c = params.get('color')
      setColorId(showroom.colors.some((x) => x.id === c) ? (c as string) : 'original')
      return
    }

    // Handoff: a scanned QR opens /car?model=<https .glb url> and goes straight to the AR viewer.
    const shared = params.get('model')
    if (shared) {
      try {
        if (new URL(shared).protocol === 'https:') setModelUrl(shared)
      } catch {
        /* ignore malformed value */
      }
    }
  }, [])

  const allSelected = VIEWS.every(({ key }) => files[key])

  function onPick(key: ViewKey, e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('image/')) return setError('Please choose image files only.')
    setError(null)
    setFiles((prev) => ({ ...prev, [key]: f }))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!allSelected) return
    setLoading(true)
    setError(null)
    setDemo(false)
    setModelUrl(null)
    setProgress(0)
    try {
      const body = new FormData()
      for (const { key } of VIEWS) body.append(key, await shrinkImage(files[key]!))

      const res = await fetch('/api/generate-car', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Generation failed.')

      if (data.demo) {
        setDemo(true)
        setModelUrl(data.modelUrl)
        return
      }

      // Real generation: poll the task until it finishes (typically 1-5 minutes).
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 4000))
        const st = await (await fetch(`/api/generate-car/status?id=${data.taskId}`)).json()
        if (st.error && !st.status) throw new Error(st.error)
        setProgress(st.progress ?? 0)
        if (st.status === 'SUCCEEDED' && st.modelUrl) return setModelUrl(st.modelUrl)
        if (st.status === 'FAILED' || st.status === 'CANCELED') throw new Error(st.error || 'Generation failed.')
      }
      throw new Error('Timed out waiting for the 3D model.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // The QR opens this page with the generated model preloaded (a raw .glb link would only download a file).
  const handoffUrl = !modelUrl || !origin
    ? ''
    : car
      ? `${origin}/car?car=${car.id}&color=${colorId}`
      : `${origin}/car?model=${encodeURIComponent(new URL(modelUrl, origin).href)}`

  const activeColor = car?.colors.find((c) => c.id === colorId)
  const paint = car && activeColor ? { material: car.paintMaterial, hex: activeColor.hex } : undefined

  return (
    <div>
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-500">Car AR</p>
          <h1 className="mt-1 text-2xl font-semibold text-stone-900 sm:text-3xl">{car ? car.name : 'Car Visualizer'}</h1>
          <p className="mt-2 text-sm text-stone-600">
            {car
              ? 'Pick a colour, then tap the AR button to park it in your driveway.'
              : 'Upload four photos of a car, generate a 3D model, then park it in your driveway with AR.'}
          </p>
        </div>
      </header>

      <main
        className={`mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 ${
          car ? 'max-w-3xl' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]'
        }`}
      >
        {!car && (
        <form onSubmit={onSubmit} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Reference photos</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {VIEWS.map(({ key, label }) => (
              <label
                key={key}
                className="relative flex aspect-[4/3] cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 text-center transition hover:border-stone-500"
              >
                {previews[key] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previews[key]} alt={`${label} view`} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-sm text-stone-500">Add {label}</span>
                )}
                <span className="absolute left-2 top-2 rounded bg-white/90 px-2 py-0.5 text-xs font-medium text-stone-700">
                  {label}
                </span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onPick(key, e)} />
              </label>
            ))}
          </div>

          <button
            type="submit"
            disabled={!allSelected || loading}
            className="mt-5 w-full rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Generating 3D model…' : 'Generate 3D Car'}
          </button>
          {!allSelected && <p className="mt-2 text-xs text-stone-500">Add all four photos to continue.</p>}
          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </form>
        )}

        {/* Viewer + QR */}
        <div className="flex flex-col gap-6">
          <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
            <div className="relative flex aspect-square w-full items-center justify-center bg-stone-50 sm:aspect-[4/3]">
              {loading ? (
                <div className="flex flex-col items-center gap-4 text-stone-500">
                  <div className="h-10 w-10 animate-spin rounded-full border-4 border-stone-300 border-t-stone-700" />
                  <p className="text-sm">Building your 3D car… {progress}% (can take a few minutes)</p>
                </div>
              ) : modelUrl ? (
                <>
                  <CarModelViewer src={modelUrl} paint={paint} orbit={car?.cameraOrbit} />
                  {demo && (
                    <p className="absolute left-3 right-3 top-3 rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900">
                      Demo mode: this is a placeholder model, not generated from your photos. Set MESHY_API_KEY to
                      enable real generation.
                    </p>
                  )}
                </>
              ) : (
                <p className="max-w-xs px-6 text-center text-sm text-stone-500">
                  Your 3D car will appear here once it’s generated.
                </p>
              )}
            </div>
          </section>

          {car && (
            <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
                {car.name} · Colour: <span className="text-stone-900">{activeColor?.name}</span>
              </h2>
              <div className="mt-4 flex flex-wrap gap-3">
                {car.colors.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.name}
                    aria-label={c.name}
                    aria-pressed={c.id === colorId}
                    onClick={() => setColorId(c.id)}
                    className={`h-10 w-10 rounded-full border-2 transition ${
                      c.id === colorId ? 'border-stone-900 ring-2 ring-stone-900 ring-offset-2' : 'border-stone-300'
                    }`}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
              <p className="mt-3 text-xs text-stone-500">
                The colour you pick carries into AR on Chrome (Android) and iPhone.
              </p>
            </section>
          )}

          {handoffUrl && isDesktop && (
            <section className="rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Open on your phone</h2>
              <div className="mx-auto mt-4 inline-block rounded-lg border border-stone-200 bg-white p-3">
                <QRCodeSVG value={handoffUrl} size={180} />
              </div>
              <p className="mt-3 text-xs text-stone-500">
                Scan with your phone camera, then tap “View Car in your Driveway (AR)”.
              </p>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
