'use client'

import { useEffect, useRef } from 'react'
import { useModelViewer } from '@/lib/useModelViewer'
import { hexToLinear } from '@/lib/cars'

type Props = {
  src: string
  /** Optional recolouring: material to tint and the sRGB hex to apply. */
  paint?: { material: string; hex: string }
  /** model-viewer camera-orbit, e.g. "215deg 75deg auto". */
  orbit?: string
}

/**
 * AR viewer tuned for large, Draco-compressed car meshes.
 * - Draco decoding is configured in useModelViewer (decoder runs in a worker).
 * - Placement is always the ground ("floor"), never a wall.
 */
export default function CarModelViewer({ src, paint, orbit }: Props) {
  const ready = useModelViewer()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null)

  // Re-apply the paint colour whenever the model (re)loads or the colour changes.
  useEffect(() => {
    const el = viewerRef.current
    if (!el || !paint) return undefined
    const apply = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mat = el.model?.materials?.find((m: any) => m.name === paint.material)
      if (mat) mat.pbrMetallicRoughness.setBaseColorFactor([...hexToLinear(paint.hex), 1])
    }
    if (el.loaded) apply()
    el.addEventListener('load', apply)
    return () => el.removeEventListener('load', apply)
  }, [ready, src, paint?.material, paint?.hex]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return <div className="h-full w-full animate-pulse bg-stone-200" />
  }

  return (
    <model-viewer
      ref={viewerRef}
      src={src}
      alt="3D car model"
      ar
      ar-modes="webxr scene-viewer quick-look"
      ar-placement="floor"
      ar-scale="fixed"
      camera-controls
      camera-orbit={orbit}
      touch-action="pan-y"
      // --- performance for 50k-100k+ polygon meshes ---
      loading="eager"
      reveal="auto"
      environment-image="neutral"
      shadow-intensity="0.8"
      shadow-softness="1"
      max-field-of-view="45deg"
      interaction-prompt="none"
      style={{ width: '100%', height: '100%', backgroundColor: '#fafaf9' }}
    >
      <button
        slot="ar-button"
        className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white shadow-lg transition hover:bg-stone-700"
      >
        View Car in your Driveway (AR)
      </button>
      <div slot="progress-bar" className="hidden" />
    </model-viewer>
  )
}
