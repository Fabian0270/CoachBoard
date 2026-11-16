import { Fragment } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'

/** One key, drawn as a key cap. */
function Key({ children }: { children: string }) {
  return (
    <kbd className="num inline-flex min-w-[1.6rem] items-center justify-center rounded border border-b-2 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
      {children}
    </kbd>
  )
}

/**
 * Settings → Help. For now the keyboard shortcuts; the first-start tour and the
 * sample athlete join it later.
 */
export default function HelpSettingsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keyboard shortcuts</CardTitle>
        <CardDescription>
          Everything in the program editor can be done from the keyboard, and everything can still be
          done with the mouse — use whichever suits you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} aria-labelledby={`shortcuts-${group.title}`}>
            <h3 id={`shortcuts-${group.title}`} className="text-sm font-semibold">{group.title}</h3>
            <p className="mb-2 text-xs text-muted-foreground">{group.where}</p>
            <dl className="divide-y rounded-md border">
              {group.shortcuts.map((s) => (
                <div key={s.does} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-3 py-2 text-sm">
                  <dt className="flex flex-wrap items-center gap-1">
                    {s.keys.map((combo, i) => (
                      <Fragment key={combo.join('+')}>
                        {i > 0 && <span className="px-0.5 text-xs text-muted-foreground">or</span>}
                        {combo.map((k, j) => (
                          <Fragment key={k}>
                            {j > 0 && <span className="text-xs text-muted-foreground">+</span>}
                            <Key>{k}</Key>
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </dt>
                  <dd className="text-muted-foreground">{s.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}
