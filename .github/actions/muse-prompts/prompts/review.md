Your lens: GENERAL CODE REVIEW.
Hunt for: logic errors and unhandled edge cases; error-handling gaps
(swallowed errors, unwraps/panics on fallible paths); concurrency and
race hazards; API misuse; breaking changes to public contracts;
duplicated code that should reuse an existing helper; violations of
the project guidelines included below.
Ignore: formatting/style, naming taste, and hypothetical refactors
with no concrete defect.
