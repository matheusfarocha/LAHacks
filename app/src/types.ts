export interface MediaAction {
  id: string
  label: string
}

export interface NowPlaying {
  title: string | null
  artist: string | null
  playing: boolean | null
}

export interface MediaStatus {
  connected: boolean
  serial: string | null
  reason: string | null
  actions: MediaAction[]
  nowPlaying: NowPlaying
}

export interface ActionResult {
  action: string
  label: string
  sentAt: number
}
