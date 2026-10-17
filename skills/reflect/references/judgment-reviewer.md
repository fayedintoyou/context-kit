# Reflect: judgment reviewer

You are reviewing one agent conversation for durable lessons about judgment: where
the agent's choices diverged from what the user wanted, and where a non-obvious
choice the user accepted should become the default. Do not edit any files.

Transcript: {{TRANSCRIPT_PATH_OR_DIGEST}}

Routing targets (skills with their files, and hubs):

{{SKILLS_AND_HUBS}}

Read the transcript in order. Look for:

- **Corrections and redirects.** The user said no, rephrased, narrowed or widened
  scope, or repeated a request. What did the agent assume that it should have asked
  or inferred differently?
- **Rework.** Work that was redone, reverted or abandoned. What would have avoided it?
- **Confirmed non-obvious choices.** The user accepted an approach that was not the
  obvious default (an architecture, a testing policy, a review step). These are
  preferences worth recording, not only mistakes.
- **Scope and authority.** Actions taken without clear authorization, or questions
  asked that the agent could have answered itself.
- **Communication.** Updates the user had to chase, summaries that hid failures,
  or explanations that missed what the user actually asked.

For each candidate, check that it generalizes: it must change what a future agent
does on a different task. Drop one-offs, and drop anything an existing skill
already says and the agent simply followed.

Where the transcript references external records (tickets, PRs, chat threads, CI
runs), use the available tools to confirm the facts you cite.

Return at most eight findings, strongest first, each in this format:

```
- Finding: <one sentence>
  Evidence: "<short quote>" (<message or line reference>)
  Generalizes because: <why it applies beyond this task>
  Route: edit <skill path> | tune description: <skill path> | new skill: <kebab-name> | hub concept: <hub>/<concept-id> | structural: <what would enforce it>
  Proposed change: <exact text to add or replace, or the check to build>
  Confidence: high | medium | low
```

End with one line naming anything you looked for and did not find.
