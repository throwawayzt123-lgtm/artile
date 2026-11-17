'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'

/**
 * Fallback for phones without ARCore/ARKit: shows the rear camera with the tile image
 * on top. Drag to move, pinch (or use the sliders) to resize/rotate. No wall tracking.
 */
export default function CameraPreview({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
      } catch {
        setError('Could not open the camera. Allow camera access for this site in Chrome and try again.')
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop()) // release the camera
      streamRef.current = null
    }
  }, [])

  const close = useCallback(() => onClose(), [onClose])

  function onDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId).map(([, p]) => p)
    const next = { x: e.clientX, y: e.clientY }

    if (others.length === 0) {
      setPos((p) => ({ x: p.x + next.x - prev.x, y: p.y + next.y - prev.y }))
    } else {
      // Two fingers: pinch to scale, twist to rotate.
      const o = others[0]
      const d0 = Math.hypot(prev.x - o.x, prev.y - o.y)
      const d1 = Math.hypot(next.x - o.x, next.y - o.y)
      const a0 = Math.atan2(prev.y - o.y, prev.x - o.x)
      const a1 = Math.atan2(next.y - o.y, next.x - o.x)
      if (d0 > 0) setScale((s) => Math.min(4, Math.max(0.2, s * (d1 / d0))))
      setRotation((r) => r + ((a1 - a0) * 180) / Math.PI)
    }
    pointers.current.set(e.pointerId, next)
  }

  function onUp(e: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black">
      <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" />

      {error ? (
        <p className="absolute inset-x-4 top-1/3 rounded-lg bg-white p-4 text-center text-sm text-red-700">{error}</p>
      ) : (
        <div
          className="absolute inset-0 touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Tile preview"
            draggable={false}
            className="pointer-events-none absolute left-1/2 top-1/2 w-[70vmin] max-w-none select-none opacity-95"
            style={{
              transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px) rotate(${rotation}deg) scale(${scale})`,
            }}
          />
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent p-4">
        <p className="text-xs text-white/90">Drag to move · pinch to resize · twist to rotate</p>
        <button
          type="button"
          onClick={close}
          className="rounded-full bg-white px-4 py-2 text-sm font-medium text-stone-900"
        >
          Close
        </button>
      </div>

      <div className="absolute inset-x-0 bottom-0 space-y-3 bg-gradient-to-t from-black/70 to-transparent p-4 text-white">
        <label className="flex items-center gap-3 text-xs">
          <span className="w-12">Size</span>
          <input
            type="range"
            min={0.2}
            max={4}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="flex-1"
          />
        </label>
        <label className="flex items-center gap-3 text-xs">
          <span className="w-12">Rotate</span>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={Math.max(-180, Math.min(180, rotation))}
            onChange={(e) => setRotation(Number(e.target.value))}
            className="flex-1"
          />
        </label>
      </div>
    </div>
  )
}
