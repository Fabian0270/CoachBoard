// ---------------------------------------------------------------------------
// The first-start tour's stops (T3, D14–D16, D22/D110, D23, D112).
//
// A stop is a page, a target on it, a title and a short text. Targets are
// marked in the pages with data-tour="<id>"; stops.test.ts checks that every
// one still exists, so a page change cannot break the tour unnoticed (T2). A
// stop without a target shows its card in the middle of the screen. A stop
// whose target does not appear is skipped, never left hanging (T1).
// ---------------------------------------------------------------------------

export interface TourContext {
  sampleAthleteId: string | null
  /** The sample's finished block, its first training day, and its drafted next block. */
  finishedProgramId: string | null
  firstDay: string | null
  draftProgramId: string | null
  discordConnected: boolean
}

/** A stop's words: fixed, or depending on the coach's setup (Discord connected or not). */
type Words = string | ((ctx: TourContext) => string)
export const words = (w: Words, ctx: TourContext): string => (typeof w === 'function' ? w(ctx) : w)

export interface TourStop {
  id: string
  chapter: string
  title: Words
  body: Words
  /** Where the stop is shown. Null skips the stop (its content is not there). */
  route: (ctx: TourContext) => string | null
  /** data-tour id of what is highlighted; none for a card in the middle. */
  target?: string
  /** Done on arrival: open the sample's first training day. */
  openDay?: boolean
  /** Done on arrival on a program: show the calendar or the block view. */
  view?: 'calendar' | 'block'
}

const athlete = (ctx: TourContext, tab?: string) =>
  ctx.sampleAthleteId ? `/athletes/${ctx.sampleAthleteId}${tab ? `?tab=${tab}` : ''}` : null
const block = (ctx: TourContext) => (ctx.finishedProgramId ? `/programs/${ctx.finishedProgramId}` : null)

export const TOUR_STOPS: TourStop[] = [
  // 1. Overview
  {
    id: 'welcome', chapter: 'Overview', route: () => '/',
    title: 'A quick look around',
    body: 'This takes about five minutes and runs on Sample Athlete, a made-up lifter, so nothing of yours is touched. Use the arrow keys or the buttons; Esc stops, and you can carry on later from Settings → Help.',
  },
  {
    id: 'sidebar', chapter: 'Overview', route: () => '/', target: 'sidebar',
    title: 'Everything is one click away',
    // The Inbox is only in the sidebar once Discord is connected — and Discord is optional.
    body: (c) => c.discordConnected
      ? 'Coaching on top — athletes, programs, bar path and the Discord inbox — and tools below. Record (at the bottom) films your screen with your voice, for feedback an athlete can watch.'
      : 'Coaching on top — athletes, programs and bar path — and tools below. Record (at the bottom) films your screen with your voice, for feedback an athlete can watch.',
  },
  {
    id: 'quick-search', chapter: 'Overview', route: () => '/',
    title: 'Ctrl+K finds anything',
    body: 'From anywhere — even while typing in a training day — press Ctrl+K and type part of a name to jump to an athlete or a program.',
  },
  {
    id: 'dashboard', chapter: 'Overview', route: () => '/', target: 'dashboard-attention',
    title: 'What needs you today',
    body: 'Blocks about to end with nothing after them, training days nobody logged, athletes without a program, payments due, and sets that came in slower than usual.',
  },
  // 2. Athletes
  {
    id: 'roster', chapter: 'Athletes', route: () => '/athletes', target: 'athlete-list',
    title: 'Your roster',
    body: 'Every athlete you coach. Sample Athlete is marked "Sample" and is left out of your numbers, your learned style and your reminders.',
  },
  {
    id: 'athlete', chapter: 'Athletes', route: (c) => athlete(c), target: 'athlete-header',
    title: 'One page per athlete',
    body: 'Their programs, maxes, progress and payments, and whether their loads are in kg or lb — everything they get from you follows it.',
  },
  {
    id: 'maxes', chapter: 'Athletes', route: (c) => athlete(c, 'maxes'), target: 'athlete-maxes',
    title: 'Maxes and the RPE cheat sheet',
    body: 'Their best lifts, and what every rep and RPE works out to from them. The day editor uses these to suggest loads.',
  },
  {
    id: 'progress', chapter: 'Athletes', route: (c) => athlete(c, 'progress'), target: 'athlete-progress',
    title: 'Progress across every block',
    body: 'Estimated maxes from the sets they logged, block after block. Further down: records as they fall, and bar speed over time.',
  },
  // 3. The program loop
  {
    id: 'programs', chapter: 'The program loop', route: () => '/programs', target: 'new-program',
    title: 'Start a program any way you like',
    body: 'Blank, a copy of a block or template, the next block generated from a finished one, or straight from your own Excel files.',
  },
  {
    id: 'calendar', chapter: 'The program loop', route: (c) => block(c), target: 'program-calendar', view: 'calendar',
    title: 'Weeks down, days across',
    body: 'Drag a day to move it, copy and paste days or whole weeks, and undo anything with Ctrl+Z. The arrow keys move between days; Enter opens one.',
  },
  {
    id: 'day-editor', chapter: 'The program loop', route: (c) => block(c), target: 'day-editor', openDay: true, view: 'calendar',
    title: 'The day editor',
    body: 'Type and press Enter to move on, all by keyboard. Last week’s line sits under each exercise, loads are suggested from the athlete’s maxes, and Page Down goes to the next day.',
  },
  {
    id: 'block-view', chapter: 'The program loop', route: (c) => block(c), target: 'block-view', view: 'block',
    title: 'One day across every week',
    body: 'Block view: one training day across the whole block, every value editable, to write a progression in one go. Pick the day at the top; Calendar (top right) goes back.',
  },
  {
    id: 'export', chapter: 'The program loop', route: (c) => block(c), target: 'export',
    title: 'Send it to the athlete',
    body: 'Preview the Excel, download it, or email it — in your own sheet’s look if you imported one.',
  },
  {
    id: 'import-results', chapter: 'The program loop', route: (c) => block(c), target: 'import-results',
    title: 'Bring their results back',
    body: 'The athlete fills in Load Used and RPE in the sheet; import it here and every day is logged.',
  },
  {
    id: 'report', chapter: 'The program loop', route: (c) => (c.finishedProgramId ? `/programs/${c.finishedProgramId}/report` : null), target: 'program-report',
    title: 'How the block went',
    body: 'How much of it was logged, and whether the RPE came in as planned. Further down: estimated maxes and volume per lift, and bar speed when sets were filmed.',
  },
  {
    id: 'next-block', chapter: 'The program loop', route: (c) => (c.draftProgramId ? `/programs/${c.draftProgramId}` : null), target: 'program-calendar', view: 'calendar',
    title: 'The next block, drafted for you',
    body: 'Generated from how the last block went, in your own style — CoachBoard learns your rep ranges, block lengths and RPE from your finished programs. Every suggestion is marked and explained, and yours to change.',
  },
  // 4. Video
  {
    id: 'bar-path', chapter: 'Video', route: () => '/analysis', target: 'analysis-start',
    title: 'Bar path and bar speed from a video',
    body: 'Open a clip, click the plate, and get the path and every rep’s speed. Coaching in person? Record with a camera, or send the set from your phone over the Wi-Fi.',
  },
  {
    id: 'discord', chapter: 'Video', route: (c) => (c.discordConnected ? '/discord-inbox' : '/settings?tab=discord'), target: 'discord',
    title: (c) => (c.discordConnected ? 'Clips from Discord, sorted for you' : 'Discord, only if you want it'),
    body: (c) => c.discordConnected
      ? 'The videos your athletes post land here, matched to the athlete and the day, with "180×3 @8" in the caption read and ready to log. You can reply with a message, an image or a video.'
      : 'Optional — nothing else needs it. If your athletes post set videos on Discord, connect it here and an Inbox appears in the sidebar: their clips land in it matched to the athlete and the day, captions read and ready to log.',
  },
  // 5. Tools
  {
    id: 'calculators', chapter: 'Tools', route: () => '/calculators', target: 'calculators',
    title: 'Calculators',
    body: 'Points for a total (IPF GL, DOTS, Wilks), and warm-up sets up to a working weight with the plates for each, in kg or lb.',
  },
  {
    id: 'styles', chapter: 'Tools', route: () => '/styles', target: 'styles',
    title: 'Your Excel look',
    body: 'Programs export in your own sheet’s layout once you have imported one, or in one of the built-in looks.',
  },
  {
    id: 'payments', chapter: 'Tools', route: () => '/payments', target: 'revenue',
    title: 'Payments and revenue',
    body: 'Who has paid and until when, revenue per month in each currency and in your own, a CSV for your books, and a reminder email for a payment that is due.',
  },
  // 6. Settings
  {
    id: 'settings', chapter: 'Settings', route: () => '/settings?tab=email', target: 'settings-tabs',
    title: 'Settings',
    body: 'Email (to send programs and reminders from CoachBoard), Discord, your preferences such as kg or lb and suggested loads, and Help.',
  },
  {
    id: 'your-data', chapter: 'Settings', route: () => '/settings?tab=data', target: 'your-data',
    title: 'Your data stays yours',
    body: 'Everything lives on this computer. A backup is made at every start and once a day, and you can keep a copy in a second folder too — OneDrive, Dropbox or a USB drive.',
  },
  {
    id: 'help', chapter: 'Settings', route: () => '/settings?tab=help', target: 'help',
    title: 'Help, any time',
    body: 'Take this tour again, load or remove Sample Athlete, and bring back the setup checklist. Further down: report a problem, and every keyboard shortcut.',
  },
  {
    id: 'end', chapter: 'Done', route: () => '/',
    title: 'That’s the tour',
    body: 'Keep Sample Athlete to try things on, or remove it now — you can load it again from Settings → Help. Next: a short checklist to set CoachBoard up for your own athletes.',
  },
]
