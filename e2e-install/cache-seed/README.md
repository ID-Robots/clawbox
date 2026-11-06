# e2e-install cache seed

`docker-compose.test.yml` mounts a folder at `/var/cache/clawbox-e2e` in the
container, read-only: `$CLAWBOX_E2E_CACHE_DIR` when it is set, this folder
otherwise. When the entrypoint seeds a fresh project and that folder holds
`next-cache/`, it is copied to the project's `.next/cache` before install.sh
runs, so the install's `next build` starts from the framework's build cache
(Turbopack's and the type check's) instead of from nothing. Next checks every
cached entry against the sources it sees, so the build is still the build of
this checkout; only the work it repeats is skipped.

`.github/workflows/e2e-install.yml` restores that cache from the Actions cache
before it boots the container, and saves the container's `.next/cache` after
the suite on pushes to `beta` and `main` (and on the schedule and a dispatch),
so every pull request into those branches starts warm.

This folder holds nothing but this file, so a local run gets no cache.
