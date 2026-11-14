import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const VIEWS = ['front', 'back', 'left', 'right'] as const
const MAX_BYTES = 4 * 1024 * 1024 // Vercel serverless request bodies are capped at ~4.5 MB total
const MESHY_URL = 'https://api.meshy.ai/openapi/v1/multi-image-to-3d'

// Used ONLY when MESHY_API_KEY is not set, so the UI can be demoed. It is NOT made from the photos.
const DEMO_GLB_URL = 'https://modelviewer.dev/shared-assets/models/Astronaut.glb'

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data.' }, { status: 400 })
  }

  const files: File[] = []
  let total = 0
  for (const view of VIEWS) {
    const f = form.get(view)
    if (!(f instanceof File) || !f.type.startsWith('image/')) {
      return NextResponse.json({ error: `Missing or invalid image for "${view}".` }, { status: 400 })
    }
    total += f.size
    files.push(f)
  }
  if (total > MAX_BYTES) {
    return NextResponse.json({ error: 'Photos are too large. Try smaller images.' }, { status: 413 })
  }

  // ---- DEMO MODE: no API key configured -----------------------------------
  // Set MESHY_API_KEY in .env.local (local) and Vercel -> Settings -> Environment Variables (live).
  const apiKey = process.env.MESHY_API_KEY
  if (!apiKey) {
    return NextResponse.json({ demo: true, status: 'SUCCEEDED', modelUrl: DEMO_GLB_URL })
  }

  // ---- REAL MODE: create a Meshy multi-image-to-3D task --------------------
  // Docs: https://docs.meshy.ai/en/api/multi-image-to-3d  (1-4 images; URLs or base64 data URIs)
  const imageUrls = await Promise.all(
    files.map(async (f) => `data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString('base64')}`),
  )

  const res = await fetch(MESHY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_urls: imageUrls,
      should_texture: true,
      enable_pbr: false,
      target_formats: ['glb'],
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.result) {
    return NextResponse.json(
      { error: data?.message || `Meshy rejected the request (${res.status}).` },
      { status: 502 },
    )
  }

  // Generation takes minutes: hand back the task id; the client polls /api/generate-car/status.
  return NextResponse.json({ demo: false, taskId: data.result })
}
