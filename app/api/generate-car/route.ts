import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
// Real photogrammetry jobs take 1-5 minutes. Raise this (plan limits apply) or,
// better, return a job id immediately and let the client poll a /status route.
export const maxDuration = 60

const VIEWS = ['front', 'back', 'left', 'right'] as const
const MAX_BYTES = 4 * 1024 * 1024 // Vercel serverless request bodies are capped at ~4.5 MB total

// Placeholder model so the UI works end-to-end. Replace with the URL your provider returns.
const MOCK_GLB_URL = 'https://modelviewer.dev/shared-assets/models/Astronaut.glb'

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data.' }, { status: 400 })
  }

  // 1. Validate the 4 reference photos -------------------------------------
  const files: Record<string, File> = {}
  let total = 0
  for (const view of VIEWS) {
    const f = form.get(view)
    if (!(f instanceof File) || !f.type.startsWith('image/')) {
      return NextResponse.json({ error: `Missing or invalid image for "${view}".` }, { status: 400 })
    }
    total += f.size
    files[view] = f
  }
  if (total > MAX_BYTES) {
    return NextResponse.json(
      { error: 'Photos are too large. Use smaller images or upload them to object storage first.' },
      { status: 413 },
    )
  }

  // 2. REAL IMPLEMENTATION (replace the mock below) ------------------------
  //
  // const apiKey = process.env.MESHY_API_KEY          // or TRIPO_API_KEY. Put it in .env.local and in
  // if (!apiKey) throw new Error('Missing API key')   // Vercel -> Settings -> Environment Variables.
  //
  // a) Provide image URLs. Most providers want public URLs or data URIs. Either:
  //      - upload each file to Vercel Blob / S3 / R2 and use the public URLs, or
  //      - base64 data URIs:  `data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString('base64')}`
  //
  // b) Create the task (Meshy multi-image-to-3D; check the current docs for exact fields):
  //      const res = await fetch('https://api.meshy.ai/openapi/v1/multi-image-to-3d', {
  //        method: 'POST',
  //        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  //        body: JSON.stringify({
  //          image_urls: [front, back, left, right],
  //          target_polycount: 30000,      // keep the mesh light for mobile AR
  //          should_texture: true,
  //        }),
  //      })
  //      const { result: taskId } = await res.json()
  //
  // c) Poll until done (GET https://api.meshy.ai/openapi/v1/multi-image-to-3d/{taskId}) until
  //    status === 'SUCCEEDED', then read model_urls.glb. Prefer: return { taskId } now and poll from
  //    a separate /api/generate-car/status route on the client, instead of holding this request open.
  //
  // d) Tripo3D works the same way: create task -> poll -> output.model URL.
  //
  // e) Provider URLs often expire. Copy the .glb into your own storage and return that URL.
  //    Ideally Draco-compress it first (gltf-transform: `gltf-transform draco in.glb out.glb`).
  //    Scene Viewer / Quick Look need a public https URL, not a blob: URL.

  // 3. MOCK ----------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 2500)) // simulate generation time

  return NextResponse.json({ status: 'succeeded', modelUrl: MOCK_GLB_URL })
}
