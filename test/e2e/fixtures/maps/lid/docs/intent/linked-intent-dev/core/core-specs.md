# linked-intent-dev workflow specs

**LLD**: docs/intent/linked-intent-dev/core/core-design.md
**Implementing artifacts**:
- plugins/linked-intent-dev/skills/linked-intent-dev/SKILL.md
- plugins/linked-intent-dev/skills/linked-intent-dev/references/capability-flags.md
- plugins/linked-intent-dev/skills/linked-intent-dev/evals/evals.json (scenario evals)

Status markers: `[x]` implemented · `[ ]` active gap · `[D]` deferred

The `linked-intent-dev` workflow skill is pure prose — its `SKILL.md` is the artifact, and per the LID-on-LID linkage inversion this file carries the artifact pointer. The skill is verified mainly by dogfooding (it is guidance the agent consults across a whole change, not one checkable run); a small scenario-eval suite covers the moments with a checkable output, such as the decision-doc offer. `[x]` marks behavior the `SKILL.md` embodies.

---

## Triggering

- `[x]` **LID-CORE-001**: When a prompt proposes a change to project code or specifications, the system SHALL consult the linked-intent-dev workflow. The skill errs toward over-triggering, since an over-triggered consult is cheap and an under-triggered one lets drift accumulate.
- `[x]` **LID-CORE-002**: While in Scoped mode, when every path a prompt touches is outside the declared `## LID Scope`, the system SHALL NOT trigger the workflow; when any touched path is in scope, it SHALL trigger.
- `[x]` **LID-CORE-003**: While in Scoped mode, when a prompt references no specific paths, the system SHALL default to triggering and SHALL confirm scope applicability with the user when the situation is ambiguous.
- `[x]` **LID-CORE-004**: While in Scoped mode, when the `## LID Scope` section is missing or empty, the system SHALL treat all prompts as in-scope and surface a one-line warning suggesting `/update-lid` to declare scope.
