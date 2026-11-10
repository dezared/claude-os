# Code standard
- Size limits: {{limits}}. Over a limit: split the file (`/split-file`), never raise a cap.
- The size baseline (`.claude/kit/size-baseline.json`) only tightens: lowering or removing a cap is free, adding or raising one is not.
- No suppressions: no `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `biome-ignore`, `# noqa`, `# type: ignore`, `//nolint`, `#[allow(`. The gate fails on a new one; fix the cause instead.
- Comments say why, in short full sentences; the code says what.
- Match the file you are in; minimal diff; do not reformat lines you did not change.
