# FoxOS development and releases

FoxOS separates ongoing development from versions intended for people who
install the public repository.

## Channels

| Channel | Purpose | Stability |
| --- | --- | --- |
| `main` | Current public release source | Stable alpha release |
| `develop` | Integrated work running on the FoxOS development server | May be incomplete |
| `feature/*` | Isolated larger work based on `develop` | Temporary |
| `vX.Y.Z` tags and GitHub Releases | Immutable snapshots offered to users | Released |

Cloning FoxOS without selecting another branch uses `main`. A user receives a
new version only after choosing to update; FoxOS does not silently pull the
repository or replace itself.

## Development flow

1. Start work from `develop` (or a `feature/*` branch based on it).
2. Validate the change locally and on the dedicated development server.
3. Keep `main` and the current release tag unchanged during this work.
4. When a release is explicitly approved, choose the next version and update
   all version declarations together.
5. Run the full release validation suite.
6. Merge the verified result into `main`, create one new immutable tag, and
   publish a GitHub Release.

The `v0.0.1` tag is the first public alpha snapshot and is frozen. Later work
will remain on `develop` until a separate release is approved.

## Required release checks

- Backend tests and syntax checks
- Frontend lint and production build
- Docker Compose and installer shell validation
- Version consistency and `git diff --check`
- Production Docker image build
- Real browser QA for affected interactions
- Development-server health and protected-API verification

## Future update experience

FoxOS may later expose `Stable` and `Preview` update channels in its UI. The
stable channel must read immutable GitHub Releases, show release notes, require
an explicit user action, preserve data, and support rollback. The preview
channel may follow `develop`, but it must remain opt-in.
