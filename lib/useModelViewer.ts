'use client'

import { useEffect, useState } from 'react'

// Pinned Draco decoder (gstatic is model-viewer's default; pinning avoids surprises on upgrade).
// To self-host (faster, works offline): copy three/examples/jsm/libs/draco/gltf/ to /public/draco/
// and use '/draco/' here.
const DRACO_DECODER = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/'

/**
 * Loads the <model-viewer> web component on the client only (it touches `window`,
 * so it can't be imported during SSR) and configures Draco decoding.
 * Returns true once the custom element is registered.
 */
export function useModelViewer(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('@google/model-viewer').then(({ ModelViewerElement }) => {
      // Draco-compressed .glb files are decoded in a web worker by model-viewer.
      ModelViewerElement.dracoDecoderLocation = DRACO_DECODER
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return ready
}
