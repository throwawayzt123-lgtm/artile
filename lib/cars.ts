export type CarColor = { id: string; name: string; hex: string }

export type ShowroomCar = {
  id: string
  name: string
  src: string
  /** Name of the glTF material that holds the body paint (recoloured by the swatches). */
  paintMaterial: string
  /** Initial camera angle so the car opens on a flattering front three-quarter view. */
  cameraOrbit?: string
  colors: CarColor[]
}

// Cars with a ready-made .glb in /public/models. Open one with /car?car=<id>[&color=<colorId>]
export const SHOWROOM_CARS: ShowroomCar[] = [
  {
    id: 'bugatti-chiron',
    name: 'Bugatti Chiron Mansory',
    src: '/models/bugatti_chiron_mansory.glb',
    paintMaterial: 'vehicle_generic_smallspecmap_PRIMARY',
    cameraOrbit: '215deg 75deg auto',
    colors: [
      { id: 'original', name: 'Original', hex: '#919191' },
      { id: 'black', name: 'Black', hex: '#0d0d0f' },
      { id: 'white', name: 'White', hex: '#f4f4f2' },
      { id: 'silver', name: 'Silver', hex: '#b9bdc4' },
      { id: 'red', name: 'Red', hex: '#c8102e' },
      { id: 'blue', name: 'Blue', hex: '#0a4aa6' },
      { id: 'yellow', name: 'Yellow', hex: '#f2c200' },
      { id: 'orange', name: 'Orange', hex: '#e8590c' },
      { id: 'green', name: 'Green', hex: '#146c43' },
    ],
  },
]

export function findCar(id: string | null) {
  return SHOWROOM_CARS.find((c) => c.id === id)
}

/** "#rrggbb" -> linear RGB [r,g,b] in 0..1 (what glTF base colour factors use). */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]
}
