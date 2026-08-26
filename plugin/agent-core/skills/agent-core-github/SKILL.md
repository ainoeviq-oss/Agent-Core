---
name: agent-core-github
description: Use Agent Core's Native GitHub Fabric for authenticated GitHub repository, Git, issue, pull request, Actions, release, package, and REST API work without interactive GitHub CLI login.
---

# Agent Core Native GitHub Fabric

Use this skill when a task requires GitHub operations through the connected Agent Core MCP app.

## Operating model

Agent Core owns authentication and transport. Do not ask the user to run `gh auth login`, paste a token into chat, add a token to a Git remote URL, or configure Windows Credential Manager. The runtime loads its GitHub credentials lazily from its local secret boundary and keeps them out of tool results, command arguments, Git configuration, memory, audit payloads, and release artifacts.

All actionable GitHub tools except `github_status` are route-bound. Obtain one coherent route through `capability_route` for the current GitHub objective and reuse that `routeContextId` for operations belonging to that objective.

## Choose the narrowest tool

Prefer purpose-built tools before the generic REST escape hatch:

- `github_status` — local Fabric/configuration and Git availability only; it does not authenticate or contact GitHub.
- `github_repo` — repository metadata, listing, creation, updates, archive, transfer, deletion.
- `github_git` — authenticated HTTPS clone, fetch, pull, push, `ls-remote`, and safe remote URL management.
- `github_issue` — issue listing, reading, creation, updates, closure, and comments.
- `github_pr` — pull request listing, reading, creation, updates, reviews, comments, and merges.
- `github_actions` — workflows, runs, dispatch, cancellation, and reruns.
- `github_release` — release listing, reading, creation, editing, deletion, and asset upload.
- `github_packages` — GitHub Packages metadata/version operations plus scoped npm view/publish/install.
- `github_api` — same-origin GitHub REST escape hatch when no purpose-built tool covers the endpoint.

Use `github_api` only after checking whether a purpose-built tool already expresses the intent more safely. Generic non-GET REST calls require the destructive confirmation gate because their mutation semantics cannot be classified reliably by endpoint alone.

## Credential boundaries

Never request, reveal, echo, summarize, fingerprint, hash, or copy GitHub credential contents. Do not place credentials in URLs, shell command strings, files that are meant to be committed, documentation, issue/PR bodies, or logs.

The general GitHub credential is for REST and authenticated HTTPS Git operations. The dedicated package credential is used only through `github_packages` or an explicitly selected package REST credential path. Do not substitute one credential for the other unless the runtime itself is changed through an approved implementation task.

## Destructive operations

Never invent or automatically supply destructive confirmation. Use the exact literal `CONFIRM_GITHUB_DESTRUCTIVE_OPERATION` only when the user has clearly and explicitly requested the guarded destructive action in the current task.

Guarded examples include repository deletion/transfer/archive, release deletion, package-version deletion, force push, PR merge, selected workflow cancellation, and generic non-GET `github_api` calls.

A route created for a read-only GitHub objective must not be repurposed for mutation. Create a new route whose task accurately states the requested mutation.

## Git transport rules

Use `github_git` rather than manually constructing authenticated Git commands. Keep remotes canonical and credential-free, normally `https://github.com/<owner>/<repo>.git`. Do not switch to SSH in Native GitHub Fabric v1 and do not embed a username/token in a remote URL.

## Failure handling

Treat structured GitHub Fabric error codes as evidence. Report authentication, permission, not-found, validation, rate-limit, Git conflict/non-fast-forward, and package access failures accurately. Do not infer broader token scopes from a single successful endpoint and do not claim a package permission that a live probe did not demonstrate.

When a read-only operation fails because a credential is missing or lacks access, explain the specific observed limitation without asking the user to expose the token value.
