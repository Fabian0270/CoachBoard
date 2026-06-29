import { renderProgramWorkbook } from './exportService.js'
import { renderWorkbookHtml } from './programPreview.js'
import {
  MINIMAL_DESCRIPTOR,
  isBuiltinTemplateId,
  type BuiltinTemplateId,
} from 'coachboard-shared/exportLayout'

// ---------------------------------------------------------------------------
// Built-in template preview — renders a fixed, synthetic sample program through
// each starter template so the New Program / Generate-program picker can show a
// faithful "what this look produces" preview (sample data, real export pipeline)
// without needing a saved program.
// ---------------------------------------------------------------------------

type ExerciseRow = {
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  rest_time: string | null
  intensity: string | null
  load_used: string | null
  rpe: string | null
  group_id: string | null
  order_index: number
  workout_id: string
}

// A sample e1RM per main lift so the Modern template's badge has something to show.
const SAMPLE_E1RM: Record<string, number> = { squat: 175, bench: 130, deadlift: 220 }

function ex(
  workoutId: string,
  order: number,
  name: string,
  sets: string,
  reps: string,
  weight: number | null,
  rpe: string | null,
): ExerciseRow {
  return {
    name, sets, reps, weight, rest_time: null, intensity: null,
    load_used: null, rpe, group_id: null, order_index: order, workout_id: workoutId,
  }
}

/** A 2-week Mon/Wed/Fri sample program with main lifts (so the e1RM badge shows). */
function buildSampleData() {
  const program = {
    name: 'Sample Program',
    start_date: '2026-01-05', // a Monday
    end_date: '2026-01-18',   // Sunday of week 2
    enabled_columns: null,
    export_layout: null,
  }
  const days: Array<[string, string]> = [
    ['mon1', '2026-01-05'], ['wed1', '2026-01-07'], ['fri1', '2026-01-09'],
    ['mon2', '2026-01-12'], ['wed2', '2026-01-14'], ['fri2', '2026-01-16'],
  ]
  const workouts = days.map(([id, scheduled_date]) => ({ id, scheduled_date }))
  const exercises: ExerciseRow[] = []
  for (const [id] of days) {
    const wk = id.endsWith('2') ? 1 : 0
    if (id.startsWith('mon')) {
      exercises.push(ex(id, 0, 'Back Squat', '3', '5', 140 + wk * 5, '@8'))
      exercises.push(ex(id, 1, 'Romanian Deadlift', '3', '8', 100, '@7'))
    } else if (id.startsWith('wed')) {
      exercises.push(ex(id, 0, 'Bench Press', '4', '6', 100 + wk * 2.5, '@7'))
      exercises.push(ex(id, 1, 'Barbell Row', '3', '10', 70, '@8'))
    } else {
      exercises.push(ex(id, 0, 'Deadlift', '3', '3', 180 + wk * 5, '@8'))
      exercises.push(ex(id, 1, 'Pull-ups', '3', '8', null, '@8'))
    }
  }
  return { program, workouts, exercises }
}

/** Render the sample program through a built-in template and return its HTML preview. */
export async function buildTemplateSamplePreviewHtml(templateId: string): Promise<string> {
  if (!isBuiltinTemplateId(templateId)) {
    throw new TemplatePreviewError('Unknown export template')
  }
  const id: BuiltinTemplateId = templateId
  const { program, workouts, exercises } = buildSampleData()

  let buffer: Buffer
  if (id === 'modern') {
    buffer = await renderProgramWorkbook(program, workouts, exercises, { modern: { e1rmRef: SAMPLE_E1RM } })
  } else if (id === 'minimal') {
    buffer = await renderProgramWorkbook(program, workouts, exercises, { templateOverride: MINIMAL_DESCRIPTOR })
  } else {
    buffer = await renderProgramWorkbook(program, workouts, exercises)
  }
  return renderWorkbookHtml(buffer)
}

export class TemplatePreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplatePreviewError'
  }
}
