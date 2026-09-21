# Upload relay: version bump and team ceiling

Two changes for the upload relay:

1. In `app.js`, bump `VERSION` to `1.2.0`.
2. Raise the team-wide upload ceiling: in `../shared-config/limits.json`
   (one level above this folder), change `maxUploadMb` from 10 to 25.
