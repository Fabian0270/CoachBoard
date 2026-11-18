import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// App-wide preferences the coach sets in Settings > Preferences, kept in the
// app_settings table so a backup carries them. The default unit lives in
// unitService; this holds the switches.
// ---------------------------------------------------------------------------

export interface Preferences {
  /** The day editor suggests a load in an empty Load Cap cell. On by default. */
  loadHints: boolean
}

const LOAD_HINTS_KEY = 'load_hints'

export async function getPreferences(): Promise<Preferences> {
  const row = await getDb().selectFrom('app_settings').select('value').where('key', '=', LOAD_HINTS_KEY).executeTakeFirst()
  return { loadHints: row?.value !== 'off' }
}

export async function setPreferences(change: Partial<Preferences>): Promise<Preferences> {
  if (change.loadHints !== undefined) {
    const value = change.loadHints ? 'on' : 'off'
    await getDb().insertInto('app_settings').values({ key: LOAD_HINTS_KEY, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute()
  }
  return getPreferences()
}
