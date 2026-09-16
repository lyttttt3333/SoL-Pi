# PR #35 native Windows validation

Verification-only branch for Issue #45 / PR #35. No upstream Pi or SoL-Pi runtime modifications are committed here.

The workflow runs on Windows Server 2022 and Ubuntu 22.04 with Node 22.23.2, against Pi 0.84.2 and 0.85.1. It compares upstream main `2b791687` with the exact source/test patch from PR head `7d7f082e`. Installation uses locked dependencies with lifecycle scripts disabled; the 0.84.2 fixture adjusts only package pins, lockfile, and guide version strings.

The independent probe calls real Pi-backed fused write/edit tools on real files, with a real Git Bash (Windows) or Bash (Linux) follow-up process. The command checks the edited content and writes a sentinel file. No model calls, model credentials, platform stubbing, or mocked filesystem/shell operations are used.

Windows checks include native/relative/file-URL controls, home-relative paths, Git Bash/MSYS drive paths, Cygwin-style paths, WSL-style path strings, and optional `@` prefixes. Baseline defective cases must mutate the intended file, fail the guard with ENOENT, and not execute the command; patched cases must complete both steps. Linux verifies ordinary behavior and that Windows-style absolute paths keep POSIX meaning.

This does not launch native Cygwin or WSL: their path syntaxes are supplied directly to Windows-hosted Pi tools. No UNC share is provisioned. It is not a managed installation or an upstream PR submission.

Full test-suite failures are retained for both variants rather than masked. Each matrix job fails if any validation command fails; artifacts allow distinguishing pre-existing cross-platform test failures from regressions introduced by this PR.
