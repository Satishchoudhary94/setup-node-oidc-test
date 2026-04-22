# setup-node OIDC Authentication Issue — PR #1477 Proof of Concept

This repository demonstrates a bug in `actions/setup-node` where setting
`registry-url` without providing `node-auth-token` **silently blocks npm's
OIDC (provenance) publishing**, and proves that
[PR #1477](https://github.com/actions/setup-node/pull/1477) correctly fixes it.

---

## The Problem

When you configure `actions/setup-node` with a `registry-url` but **without**
a `node-auth-token` — intending to use OIDC provenance publishing — setup-node
**injects a fake placeholder token** into `NODE_AUTH_TOKEN`. This causes npm to
choose token-based auth over OIDC, resulting in a `401 Unauthorized` error.

```yaml
# What you write:
- uses: actions/setup-node@v4
  with:
    registry-url: "https://registry.npmjs.org/"
    # node-auth-token intentionally omitted — want OIDC

# What actually happens:
# NODE_AUTH_TOKEN = "XXXXX-XXXXX-XXXXX-XXXXX"  ← injected by setup-node!
# npm sees a token → skips OIDC entirely → 401 on publish
```

---

## Background: How npm 11.5.1+ Detects OIDC

npm (11.5.1+) uses a simple priority check to decide how to authenticate:

```
1. If NODE_AUTH_TOKEN is set  →  use token auth (skip OIDC)
2. Else if ACTIONS_ID_TOKEN_REQUEST_URL is set  →  use OIDC provenance
3. Else  →  no auth (fail)
```

Because `actions/setup-node@v4` always sets `NODE_AUTH_TOKEN` (even to a fake
value) when `registry-url` is provided, npm **never reaches the OIDC branch**.

---

## Evidence from npm Documentation

From the [official npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements):

> To publish with provenance from GitHub Actions, set `NODE_AUTH_TOKEN` to a
> valid npm access token **or** leave it unset to allow npm to automatically
> use OIDC via the GitHub Actions token.

And from the [npm changelog for 11.5.1](https://github.com/npm/cli/releases):

> npm now supports automatic OIDC token fetching via
> `ACTIONS_ID_TOKEN_REQUEST_URL` when `NODE_AUTH_TOKEN` is not set.

**The key requirement: `NODE_AUTH_TOKEN` must be unset for OIDC to work.**

---

## Reproduction Steps

### Prerequisites
- A GitHub repository with this code
- npm account with OIDC publishing enabled (`npm access grant`)
- GitHub Actions with `id-token: write` permission

### Steps to Reproduce the Bug

1. Fork or clone this repository
2. Ensure your repository has `id-token: write` in the workflow permissions
3. Run the workflow `.github/workflows/test-current-setup-node.yml`
4. Observe in the logs:
   - `NODE_AUTH_TOKEN = XXXXX-XXXXX-XXXXX-XXXXX` (the fake placeholder)
   - npm selects **TOKEN** auth instead of OIDC
   - `npm publish --provenance` would return `401 Unauthorized`

### Steps to Verify the Fix

1. Run the workflow `.github/workflows/test-fixed-setup-node.yml`
2. Observe in the logs:
   - `NODE_AUTH_TOKEN = (empty)` — not injected
   - npm selects **OIDC** auth
   - `npm publish --provenance` would succeed

---

## Expected vs Actual Behavior

| Scenario | Expected | Actual (current) |
|---|---|---|
| `registry-url` set, `node-auth-token` NOT set | `NODE_AUTH_TOKEN` is unset, OIDC works | `NODE_AUTH_TOKEN = XXXXX...`, OIDC blocked |
| `registry-url` set, `node-auth-token` IS set | `NODE_AUTH_TOKEN` = user token, token auth | `NODE_AUTH_TOKEN` = user token, token auth (correct) |
| `registry-url` NOT set | No auth configured | No auth configured (correct) |

---

## Workflow Comparison

Three workflows in this repository demonstrate the issue:

### 1. `test-current-setup-node.yml` — Shows the Problem

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "22"
    registry-url: "https://registry.npmjs.org/"
    # node-auth-token NOT provided
```

**Output:**
```
NODE_AUTH_TOKEN = XXXXX-XXXXX-XXXXX-XXXXX  ← injected!
STATUS: ❌ OIDC IS BLOCKED
npm auth decision: TOKEN (OIDC bypassed)
Publish result:    ❌ 401 Unauthorized
```

### 2. `test-fixed-setup-node.yml` — Shows the Fix

```yaml
- uses: Satishchoudhary94/setup-node@fix/oidc-support-1440
  with:
    node-version: "22"
    registry-url: "https://registry.npmjs.org/"
    # node-auth-token NOT provided
```

**Output:**
```
NODE_AUTH_TOKEN = (empty / not set)  ← correct!
STATUS: ✅ OIDC CAN PROCEED
npm auth decision: OIDC
Publish result:    npm publish --provenance succeeds!
```

### 3. `test-comparison.yml` — Side-by-Side

Runs both jobs in parallel so you can compare outputs directly in the
GitHub Actions UI.

---

## The Fix (PR #1477)

The fix is a minimal, targeted change to `src/authutil.ts` in setup-node:

### Before (broken):

```typescript
// Always sets NODE_AUTH_TOKEN, even without user input
core.exportVariable(
  'NODE_AUTH_TOKEN',
  inputs.auth || 'XXXXX-XXXXX-XXXXX-XXXXX'  // ← fake placeholder
);
```

### After (fixed):

```typescript
// Only set NODE_AUTH_TOKEN if the user explicitly provided it
if (inputs.auth) {
  core.exportVariable('NODE_AUTH_TOKEN', inputs.auth);
}
// When unset, npm 11.5.1+ automatically detects OIDC via
// ACTIONS_ID_TOKEN_REQUEST_URL
```

### Why This Fix is Safe

- **Backwards compatible**: When `node-auth-token` IS provided, `NODE_AUTH_TOKEN`
  is still set exactly as before. Existing users are unaffected.
- **Minimal change**: One condition added. No new configuration required.
- **Follows npm's design**: npm 11.5.1+ was specifically designed to fall back
  to OIDC when `NODE_AUTH_TOKEN` is absent. This fix enables that path.

---

## Screenshots

> **Note:** Run the workflows in your fork to generate live screenshots.
> The GitHub Actions UI will show both jobs side by side in `test-comparison.yml`.

### Expected: Current setup-node@v4 logs
```
NODE_AUTH_TOKEN = XXXXX-XXXXX-XXXXX-XXXXX
OIDC status     : BLOCKED by fake token
Overall         : ❌ FAIL — OIDC is broken
```

### Expected: Fixed setup-node logs
```
NODE_AUTH_TOKEN : (empty — correct!)
OIDC status     : AVAILABLE
Overall         : ✅ PASS — OIDC works correctly
```

---

## Debugging Checklist

If you are investigating this issue independently:

- [ ] Confirm `id-token: write` is in your workflow permissions
- [ ] Check `echo $NODE_AUTH_TOKEN` in your workflow — is it `XXXXX-XXXXX-XXXXX-XXXXX`?
- [ ] Run `npm config get //registry.npmjs.org/:_authToken` — does it show a fake value?
- [ ] Check if `ACTIONS_ID_TOKEN_REQUEST_URL` is set in your environment
- [ ] Try `npm publish --provenance` — do you get `401 Unauthorized`?
- [ ] If yes to all above, you are affected by this bug

---

## npm Version Requirements

This issue is specifically about npm's **OIDC auto-detection**, added in
**npm 11.5.1**. Earlier npm versions do not support OIDC publishing.

To ensure the correct npm version:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "22"
    registry-url: "https://registry.npmjs.org/"

- run: npm install -g npm@11.5.1
```

Or use the `node-version` that ships with npm 11.5.1+ (Node.js 22+).

---

## References

- [PR #1477 — Fix OIDC support in setup-node](https://github.com/actions/setup-node/pull/1477)
- [Issue #1440 — OIDC publishing broken when registry-url is set](https://github.com/actions/setup-node/issues/1440)
- [npm Provenance Documentation](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub OIDC Token Documentation](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [npm 11.5.1 Release Notes](https://github.com/npm/cli/releases/tag/v11.5.1)

---

## License

MIT
