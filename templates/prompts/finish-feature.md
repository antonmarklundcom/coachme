<!-- coachme prompt template: finish-feature.
     The generator fills each double-braced slot and coachme prepends the mandatory
     header (branch, PR title, "read AGENTS.md first", stop when green). Do not
     write a header here. -->

Finish **{{feature}}** in `{{repo}}`.

## Where it stands
{{where}}

## What to do
1. Read the existing implementation before changing it — match its conventions,
   its naming and its comment density rather than introducing your own.
2. Finish the feature. Keep the change minimal: this item, nothing adjacent.
3. Add or extend a test that would fail without your change.
4. Run the repo's own checks (build, lint, typecheck, tests) and get them green.

## Exit criteria
{{exit_criteria}}
- The repo's build, lint and test commands all pass locally.
- The diff touches only what this item describes.

## If you get stuck
Do not widen the scope and do not guess at a credential. Write what is blocking
you in the PR body, push what you have, and stop.
