This folder contains `unitctl`, a small unit-conversion CLI. Get to know how
it is put together, then add **temperature** support the same way the existing
units are done:

- celsius ↔ fahrenheit and celsius ↔ kelvin, both directions each
- wired in exactly the way the existing unit modules are wired in
- listed in the README's conversion table like the others
- covered by tests in the same style as the existing ones, in `test/`

Every existing test must still pass, and your new tests must pass. Run
`node --test` yourself to verify before you finish.
