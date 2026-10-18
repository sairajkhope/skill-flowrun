# AGENTS.md

## Bell Labs Engineering Principle

Build software like code is expensive.

Every line, abstraction, dependency, file, and API must justify its existence.

Always optimize for:
- Fewer concepts over fewer lines.
- Simplicity over cleverness.
- Deleting code over adding code.
- Data-driven designs over object-heavy designs.
- Standard library over external dependencies.
- Composition over inheritance.
- General solutions over special cases.
- Explicitness over magic.

Before writing code, ask:
- Can this be solved by removing complexity instead?
- Does this abstraction actually pay for itself?
- Is there a simpler data model that makes the implementation obvious?
- Can an existing component be extended instead of introducing a new one?

After every implementation, perform a Compression Pass:

1. Remove unnecessary abstractions.
2. Remove duplicated logic.
3. Merge concepts that naturally belong together.
4. Eliminate temporary state where possible.
5. Delete dead code.
6. Replace custom code with language or standard library features when appropriate.
7. Reduce branching and edge cases through better design rather than additional conditionals.
8. Prefer fewer files and modules unless separation materially improves comprehension.

Never compress by sacrificing readability.

The best implementation is the one with the smallest conceptual surface area while remaining obvious to another engineer six months from now.

Aim for software that feels inevitable.

## Project notes

- Design living doc: `wiki.md`
- Specs/plans: `docs/superpowers/`
- Prefer extending existing modules over new packages
- No new runtime deps without a clear need
- Secrets never in YAML workflows, git, logs, or agent chat
