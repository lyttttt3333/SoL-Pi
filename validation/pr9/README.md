# PR9 Unicode path validation

Verification-only fork branch. No upstream Pi or SoL-Pi runtime code is committed here. Base is main `2b791687`; source/test patch is PR9 head `8c46b763`.

Four isolated jobs cover Windows Server 2022 and Ubuntu 22.04, Pi 0.84.2 and 0.85.1, Node 22.23.2. Dependencies are installed with lifecycle scripts disabled. The older Pi fixture adjusts only development dependency pins, lockfile, and guide version strings.

Each job runs the original suite, then PR9's new tests against unchanged runtime code (all eight new cases must fail), then the patched full suite. Logs record every exit code. Independent probes before/after the fix perform real Pi-backed file mutations and real Bash commands, using standalone CJS checkers to avoid Windows inline-command quoting issues. No provider calls, credentials, platform stubs, or filesystem/shell mocks are used by the independent probe.

Each independent probe has 92 cases: all 15 normalized Unicode spaces for write/edit with and without `@` (60); representative absolute/home/raw-file-URL paths (12); percent-encoded file URLs that preserve the Unicode filename (4); ASCII-space and non-normalized Unicode controls (16). Baseline expects 72 successful mutations followed by ENOENT guard skips, and 20 fully successful controls. After the patch all 92 must complete the mutation and command successfully.

The full-suite checks retain any original Windows failures; the workflow is not forced green. This is focused regression validation, not a managed installation, live-model benchmark, combined PR9+PR35 validation, or upstream PR submission. Only JSON reports and logs are uploaded, not the isolated HOME or npm cache.
