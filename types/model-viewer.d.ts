import 'react'

// Lets TSX accept the <model-viewer> custom element.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'model-viewer': any
    }
  }
}
