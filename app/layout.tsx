import type { Metadata, Viewport } from 'next'
import Navigation from '@/components/Navigation'
import './globals.css'

export const metadata: Metadata = {
  title: 'AR Platform – Tile & Car',
  description: 'View tiles on your wall and cars in your driveway using augmented reality.',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-100 text-stone-800 antialiased">
        <Navigation />
        {children}
      </body>
    </html>
  )
}
