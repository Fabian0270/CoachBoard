// ---------------------------------------------------------------------------
// Every keyboard shortcut in the program editor, in one place.
//
// Shown in Settings → Help (and, later, in the first-start tour). Kept as data
// rather than written into the page; shortcuts.test.tsx presses every key the
// "Program buttons" group names and checks that it does something.
// ---------------------------------------------------------------------------

export interface Shortcut {
  /** Each entry is one key combination, e.g. ['Ctrl', 'Enter']. Alternatives are separate entries. */
  keys: string[][]
  does: string
}

export interface ShortcutGroup {
  title: string
  /** When these keys apply. */
  where: string
  shortcuts: Shortcut[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Program calendar',
    where: 'On a program, with no day open. The arrow keys work straight away — no click needed.',
    shortcuts: [
      { keys: [['←'], ['→'], ['↑'], ['↓']], does: 'Move between days (up and down move a week)' },
      { keys: [['Enter']], does: 'Open the day' },
      { keys: [['Ctrl', 'C']], does: 'Copy the day' },
      { keys: [['Ctrl', 'X']], does: 'Cut the day' },
      { keys: [['Ctrl', 'V']], does: 'Paste onto the day, replacing it' },
      { keys: [['Delete']], does: 'Clear the day' },
      { keys: [['Ctrl', 'Z']], does: 'Undo the last change, while its Undo is showing' },
    ],
  },
  {
    title: 'Program buttons',
    where: 'On a program, with nothing else open.',
    shortcuts: [
      { keys: [['Ctrl', 'E']], does: 'Export (preview, download, email)' },
      { keys: [['Ctrl', 'I']], does: "Import the athlete's results" },
      { keys: [['Ctrl', 'R']], does: 'Open the report' },
      { keys: [['Ctrl', 'Shift', 'C']], does: 'Choose columns' },
      { keys: [['Ctrl', 'Shift', 'D']], does: 'Change the dates' },
    ],
  },
  {
    title: 'Inside a day',
    where: 'With a training day open.',
    shortcuts: [
      { keys: [['Enter']], does: 'Save and go to the next field; after the last one, the next exercise, or a new one' },
      { keys: [['Shift', 'Enter']], does: 'New line in the field' },
      { keys: [['Tab'], ['Shift', 'Tab']], does: 'Next / previous field' },
      { keys: [['↑'], ['↓']], does: 'Same field on the exercise above / below' },
      { keys: [['Ctrl', 'Enter']], does: 'Add a set' },
      { keys: [['Ctrl', 'D']], does: 'Duplicate the exercise' },
      { keys: [['Ctrl', 'L']], does: "Use the suggested load from the athlete's max" },
      { keys: [['Ctrl', 'V']], does: 'Paste rows copied from Excel: they fill in from the cell you are in, and down into new rows' },
      { keys: [['Ctrl', 'Delete']], does: 'Delete the exercise' },
      { keys: [['Alt', '↑'], ['Alt', '↓']], does: 'Move the exercise up / down' },
      { keys: [['Page Down'], ['Page Up']], does: 'Next / previous day' },
      { keys: [['Ctrl', 'Page Down'], ['Ctrl', 'Page Up']], does: 'Same weekday next / previous week' },
      { keys: [['Ctrl', 'Z']], does: 'Undo the last change, while its Undo is showing' },
      { keys: [['Esc']], does: 'Save what you typed and close the day' },
    ],
  },
  {
    title: 'Exercise name suggestions',
    where: 'While the list under an exercise name is open.',
    shortcuts: [
      { keys: [['↑'], ['↓']], does: 'Choose a suggestion' },
      { keys: [['Enter'], ['Tab']], does: 'Take it' },
      { keys: [['Esc']], does: 'Close the list (a second Esc closes the day)' },
    ],
  },
  {
    title: 'Menus and dialogs',
    where: 'Everywhere in the program editor.',
    shortcuts: [
      { keys: [['↑'], ['↓']], does: 'Move through a menu' },
      { keys: [['Enter']], does: 'Choose the item, or press the focused button' },
      { keys: [['Esc']], does: 'Close the menu or dialog and go back to where you were' },
    ],
  },
]
