import type { CmApi } from '@shared/api'

declare global {
  interface Window {
    cm: CmApi
  }
}

export {}
