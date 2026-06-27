// External import service — split into focused modules under ./external-import/.
// This barrel preserves the public surface so routes and tests can keep importing
// from './externalImportService.js'.
export { parseExternalFile } from './external-import/parseExternalFile.js'
export { commitExternalProgram } from './external-import/commit.js'
export { guessFocus } from './external-import/focus.js'
