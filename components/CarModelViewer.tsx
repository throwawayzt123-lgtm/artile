'use client'

import { useModelViewer } from '@/lib/useModelViewer'

/**
 * AR viewer tuned for large, Draco-compressed car meshes.
 * - Draco decoding is configured in useModelViewer (decoder runs in a worker).
 * - Placement is always the ground ("floor"), never a wall.
 */
export default function CarModelViewer({ src }: { src: string }) {
  const ready = useModelViewer()
  if (!ready) {
    return <div className="h-full w-full animate-pulse bg-stone-200" />
  }

  return (
    <model-viewer
      src={src}
      alt="Generated 3D car model"
      ar
      ar-modes="webxr scene-viewer quick-look"
      ar-placement="floor"
      ar-scale="fixed"
      camera-controls
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
