# Design

## Decisions

- **Concept IDs are OKF IDs within a hub.** A concept is addressed as `(hub id, concept id)`, the concept ID being the bundle-relative path without `.md` (OKF §2). Federation will add a bundle namespace on top without changing in-hub IDs.
- **Listings come from frontmatter, the index is context.** Each entry is built from the concept's own frontmatter, so it is accurate even when a hand-written `index.md` is stale. The index body is returned alongside, unparsed, because OKF leaves index layout soft (§8). Subdirectory entries carry the count of concepts they contain and, when present, the title line of their `index.md`.
- **Links are parsed, not followed.** `read` extracts inline Markdown links outside code and resolves root-relative (OKF-recommended) and relative targets against the hub. Anchors and query strings are dropped. Classification uses the file and directory sets collected while loading the hub, so it never touches the file system and cannot reveal dot-directories or paths behind symlinks. The kinds are fixed now (concept with `hub`, directory, file, external, outside, missing) so federation only adds values: a link leaving the hub becomes resolvable when a mount names it.
- **Curated is membership, not trust.** `curated` means listed in `hub.json` documents; `inbox` marks captured notes. OKF `status` and trust stay separate, so agent-written drafts (wiki upkeep) never look curated.
- **Search covers every concept** (inbox opt-in), still within the 2 MiB scan and 50 result limits, so anything browse shows is findable.
- **Response size.** Descriptions in listings are capped at 300 characters and index bodies at 16 KiB; full frontmatter is returned only on request. Concepts and directories are separate arrays with totals and an offset, sorted by code point for stable paging.
- **Entry point.** `context` names the hub root to browse, and tool descriptions explain listing then reading.
- **Federation placement.** Mounted bundles will never live inside a hub directory, so mounted files can never collide with local concept IDs.
- **Reuse the bundle check.** Navigation uses the concepts collected during hub loading, so a file is readable only if it is a conformant concept and lenient-read warnings apply unchanged.

## Risks / Trade-offs

- [Link parsing misses reference-style links] → Inline links are what OKF examples and our writers use; reference-style links can be added if they appear.
- [Large directories] → Truncation is explicit with totals and an offset.
