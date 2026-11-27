// ESLint for the client, kept to the rules that catch real bugs rather than
// style: React's rules of hooks (a hook called conditionally breaks React's
// state silently) and the dependency check on effects. The code carried
// `eslint-disable react-hooks/...` comments for years with no ESLint installed,
// so nothing was actually checking them.
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'public/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    // Registered for the names only: the code has a few disable comments for
    // its rules, and an unknown rule name in one is an error.
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
