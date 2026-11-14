export const runtime = 'nodejs'

// GET /api/generate-car/model?u=<meshy asset url>  - streams the .glb through our domain.
// Only meshy.ai hosts are allowed so this can't be used as an open proxy.
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get('u')
  let target: URL
  try {
    target = new URL(u ?? '')
  } catch {
    return new Response('Bad url', { status: 400 })
  }
  if (target.protocol !== 'https:' || !(target.hostname === 'meshy.ai' || target.hostname.endsWith('.meshy.ai'))) {
    return new Response('Forbidden host', { status: 403 })
  }

  const upstream = await fetch(target, { cache: 'no-store' })
  if (!upstream.ok || !upstream.body) return new Response('Model unavailable', { status: 502 })

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
