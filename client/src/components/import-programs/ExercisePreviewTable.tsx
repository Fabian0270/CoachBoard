import type { ExternalImportPreview } from 'coachboard-shared'

export default function ExercisePreviewTable({ preview }: { preview: ExternalImportPreview }) {
  return (
    <div className="overflow-x-auto rounded border max-h-[40vh]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-medium">Week</th>
            <th className="px-3 py-2 text-left font-medium">Day</th>
            <th className="px-3 py-2 text-left font-medium">Exercise</th>
            <th className="px-3 py-2 text-center font-medium">Sets</th>
            <th className="px-3 py-2 text-center font-medium">Reps</th>
            <th className="px-3 py-2 text-center font-medium">Intensity</th>
            <th className="px-3 py-2 text-center font-medium">Load</th>
            <th className="px-3 py-2 text-center font-medium">RPE</th>
          </tr>
        </thead>
        <tbody>
          {preview.exercises.map((ex, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="px-3 py-1.5 text-muted-foreground">{ex.weekLabel}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{ex.dayLabel}</td>
              <td className="px-3 py-1.5 font-medium">{ex.name}</td>
              <td className="px-3 py-1.5 text-center">{ex.sets ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.reps ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.intensity ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.load ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.rpe ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
