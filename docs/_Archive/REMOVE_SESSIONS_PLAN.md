# Session Management Removal Assessment & Plan

The `/v1/sessions` endpoints are a v1-era feature that maintains server-side conversation state. The gateway is now explicitly stateless, so this surface is dead weight.

## Current State

The integration test suite has 8 tests that exercise `/v1/sessions`:

| Line | Test | Action |
|------|------|--------|
| 363 | `should create a session` | Remove |
| 369 | `should retrieve the session` | Remove |
| 377 | `should send a message through the session and accumulate history` | Remove (depends on session) |
| 393 | `should recall session context in a follow-up message` | Remove (depends on session) |
| 405 | `should patch session settings` | Remove (uses `strategy: 'compress'`) |
| 416 | `should delete the session` | Remove |
| 540 | `should return 404 for non-existent session` | Remove (route doesn't exist) |
| 542 | `should return 404 when using a non-existent session ID for chat` | Remove (uses `X-Session-Id` header) |

Plus the `describe('Sessions lifecycle', ...)` wrapper on line 362.

A code search in `src/` confirms no route implementations exist:

```
git grep "/v1/sessions" src/
```

Returns 0 matches. The endpoints are advertised in `documentation/api_rest.md` line 1284 but do not exist in code.

## Removal Plan

### 1. Test Suite Pruning
**Target file:** `tests/integration.test.js`

- Remove the `describe('Sessions lifecycle', ...)` block (lines 362-419, 6 tests)
- Remove the two error-handling tests that reference sessions (lines 540-543 and 545-552)
- Total: 8 tests removed

### 2. Documentation Scrubbing
**Target file:** `documentation/api_rest.md`

- Remove the example at line 1284:
  ```js
  const session = await fetch('/v1/sessions', {method: 'POST'});
  ```

### 3. Code Audit (no changes expected)
- Verify `src/routes/` has no `sessions.js` or session-related code
- Verify `src/core/adapters.js` has no session logic
- Verify `src/core/model-router.js` has no `X-Session-Id` handling

## Summary

Sessions are a phantom v1 feature. The gateway has been stateless for a while and clients are responsible for conversation history. The dead tests in the integration suite give the false impression of a working feature.

No code logic changes — purely test and documentation cleanup. The integration tests in `tests/integration.test.js` are excluded from the default `npm test` (run via `npm run test:integration`), so this fix doesn't affect CI.
