import { getJson, sendJson } from '../lib/api'

/** Where the tour and the setup checklist stand, kept with the app's data (T8). */
export interface TourStatus {
  welcomeAnswered: boolean
  tourAt: number | null
  tourFinished: boolean
  checklist: { completed: string[]; skipped: string[]; done: boolean }
  hasOwnData: boolean
}

export type TourChange = Partial<Pick<TourStatus, 'welcomeAnswered' | 'tourAt' | 'tourFinished'>> & {
  checklist?: Partial<TourStatus['checklist']>
}

export const getTourStatus = () => getJson<TourStatus>('/api/settings/tour')
export const saveTour = (change: TourChange) => sendJson<TourStatus>('PUT', '/api/settings/tour', change)

export interface SampleStatus {
  loaded: boolean
  athleteId: string | null
  /** The sample's saved squat (D110); absent from a server without the clip. */
  analysisId?: string | null
}
export const getSample = () => getJson<SampleStatus>('/api/sample')
export const loadSample = () => sendJson<SampleStatus>('POST', '/api/sample')
export const removeSample = () => sendJson<SampleStatus>('DELETE', '/api/sample')
