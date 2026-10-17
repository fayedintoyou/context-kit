# Spec Delta

## ADDED Requirements

### Requirement: Core provides repository routing
The `core` addon SHALL list the generated `my-repos` skill among its skills when the workspace registers repositories, and `addons` SHALL report it under `core` as generated.

#### Scenario: Core lists the routing skill
- **WHEN** a workspace registers a repository and a caller runs `addons`
- **THEN** the `core` entry lists `context-kit` and `my-repos`, with `my-repos` marked generated
