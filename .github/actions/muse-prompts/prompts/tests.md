Your lens: TEST COVERAGE (of this diff, not the whole repository).
Method: (1) enumerate the behavior changes in this diff — new
features, changed logic, bug fixes; (2) map each to test changes in
the diff or clearly-referenced existing tests; (3) report each gap
as a finding naming the exact behavior plus a CONCRETE test to add:
suggested test name, scenario, expected result.
Severity: bug fix without a regression test = high; new core
behavior untested = high/medium; error paths, migrations, and
boundary conditions untested = medium; nice-to-have cases = low.
Non-behavioral changes (docs, CI, pure refactors with existing
coverage) need no tests — say so and pass.
