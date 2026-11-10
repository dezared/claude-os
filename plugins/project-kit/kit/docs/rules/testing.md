# Testing: three contours

{{testing}}

## Running things

- Contour A runs by itself after each edit (the kit's after-edit hook); over its budget the tests are deferred to Stop.
- Contour B is the gate: `{{gate}}`. The Stop hook runs it on a changed tree and gives up after three red stops.
- Contour C (slow suites, builds, e2e) goes to the test-runner agent, in the background.
