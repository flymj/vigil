# GitHub Git HTTPS Authentication Fix

## Problem

Vigil stores a valid GitHub fine-grained personal access token and successfully uses it with the GitHub REST API. Repository branch inspection and full synchronization fail because Git receives the token as an `Authorization: Bearer` header. GitHub Git-over-HTTPS expects HTTP Basic authentication with a username and the personal access token as the password.

GitHub repository addresses, including SCP-style SSH input, currently normalize to an HTTPS clone URL. Supporting SSH transport is outside this fix.

## Considered approaches

### A. Use Basic authentication for Git commands (selected)

Encode `x-access-token:<token>` as the HTTP Basic credential for Git branch inspection and repository synchronization. Keep Bearer authentication unchanged for GitHub REST API calls.

This is the smallest change, matches the observed failure, and preserves existing repository identity and URL behavior.

### B. Preserve SSH input and support both transports

Keep `git@github.com:...` addresses as SSH clone URLs while using PAT authentication only for HTTPS addresses. This would require changes to source normalization, persisted repository migration, authentication status, and tests. It is useful as a separate feature but unnecessary for the reported failure.

### C. Configure a Git credential helper or askpass program

Provide credentials through Git's credential protocol instead of an HTTP header. This introduces additional process lifecycle, cleanup, and secret-exposure concerns without improving the current use case.

## Design

Add a small pure helper that converts a non-empty GitHub token into the Git HTTP authorization header:

```text
Authorization: Basic base64("x-access-token:<token>")
```

Both Git execution paths use this helper:

- `inspectRepositoryAddress` for `git ls-remote`
- `syncFullRepository` for clone, fetch, checkout, and merge operations

The existing encrypted token storage remains unchanged. The GitHub REST client continues to send `Authorization: Bearer <token>` because that transport already succeeds.

## Error handling and security

- Empty tokens continue to produce no Git authentication header.
- Invalid or unauthorized tokens continue to surface the Git command failure; Vigil does not silently retry anonymously because that could hide credential problems and behave differently for private repositories.
- The token remains in the child process environment rather than command-line arguments and is not included in application responses or error messages.

## Testing

Use test-driven development:

1. Add a focused unit test that expects the Git header helper to produce Basic authentication and verifies the decoded credential is exactly `x-access-token:<token>`.
2. Add an empty-token assertion to preserve unauthenticated public repository behavior.
3. Run the focused test before implementation and confirm it fails because the helper does not exist.
4. Implement the helper and update both Git call sites.
5. Run the full test suite and production build.
6. Re-run the live branch inspection against `sgl-project/sglang` using the configured token and current API process.

## Success criteria

- The configured GitHub token remains valid for REST API calls.
- Branch inspection succeeds for `sgl-project/sglang` with the configured token.
- Full repository synchronization uses the same Basic credential format.
- Existing tests and build pass without changes to GitHub REST authentication or repository address normalization.
