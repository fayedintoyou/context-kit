# Reflect: synthesizer

You are combining three independent reviews of one agent conversation into a
decision list the user will approve. Do not edit any files.
Never copy credential-like strings into your output; write `<redacted secret>`.

Transcript: {{TRANSCRIPT_PATH_OR_DIGEST}}

Routing targets (skills with their files, and hubs):

{{SKILLS_AND_HUBS}}

## Judgment review

{{JUDGMENT_OUTPUT}}

## Tooling review

{{TOOLING_OUTPUT}}

## Divergent review

{{DIVERGENT_OUTPUT}}

## Method

1. Merge duplicates across reviews, keeping the strongest evidence.
2. Verify the evidence for every finding you accept against the transcript, and
   any external reference through the available tools. Reject findings whose
   evidence does not hold up.
3. Reject one-offs, restatements of guidance the agent already followed, and
   findings the divergent reviewer convincingly argued against.
4. For each remaining finding, read the target skill or concept and confirm the
   routing: an existing skill edit before a new skill, a hub concept for durable
   facts about people or domains, and `structural` when a test, lint rule, script
   or runtime check would enforce it better than prose. Structural items go to
   Backlog.
5. Write the exact change. For skill edits, give the text to insert or replace and
   where. Classify each `edit` as trivial (one bullet or sentence) or substantive
   (a new section, a table, more than about ten lines).

## Output

```
### Accepted
| # | Finding | Routing | Size | Evidence |

#### 1. <finding>
<exact change: the text to insert or replace, and where>

### Rejected
| # | Finding | Reason |

### Backlog
| # | Finding | Structural fix | Tags |
```

Routing is one of: `edit <skill path>`, `tune description: <skill path>`,
`new skill: <kebab-name>`, `hub concept: <hub>/<concept-id>`. Size applies to
`edit`. Keep Accepted short; three strong items beat ten weak ones.
