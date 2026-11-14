import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// GET /api/generate-car/status?id=<taskId>
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id')
  const apiKey = process.env.MESHY_API_KEY
  if (!id || !/^[\w-]+$/.test(id)) return NextResponse.json({ error: 'Bad task id.' }, { status: 400 })
  if (!apiKey) return NextResponse.json({ error: 'MESHY_API_KEY is not set.' }, { status: 500 })

  const res = await fetch(`https://api.meshy.ai/openapi/v1/multi-image-to-3d/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  })
  const task = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: task?.message || 'Status check failed.' }, { status: 502 })

  const glb: string | undefined = task.model_urls?.glb
  return NextResponse.json({
    status: task.status, // PENDING | IN_PROGRESS | SUCCEEDED | FAILED | CANCELED
    progress: task.progress ?? 0,
    error: task.task_error?.message || undefined,
    // Served through our own proxy: avoids CORS problems and gives AR apps a public https URL.
    modelUrl: task.status === 'SUCCEEDED' && glb ? `/api/generate-car/model?u=${encodeURIComponent(glb)}` : undefined,
  })
}
