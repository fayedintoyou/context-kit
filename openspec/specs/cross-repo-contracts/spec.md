# cross-repo-contracts Specification

## Purpose
Describe agreements between repositories as contract specs in a shared OpenSpec store, naming the repositories each one binds, so every party can see what it has agreed to.

## Requirements

### Requirement: Party declaration
A store MAY declare its parties in `openspec/parties.yaml`, mapping each party name (lowercase words joined by hyphens) to a repository upstream, a git URL or `https://github.com/<owner>/<name>`. Two parties SHALL NOT share an upstream. `specs parties --store <id>`, `list_parties` over MCP, SHALL return the parties and contracts with the store as source.

#### Scenario: Parties are listed
- **WHEN** a declared store's parties file names `site` and `game` with their upstreams, and a caller runs `specs parties --store <id>` and calls `list_parties` with that store
- **THEN** both return the two parties with their upstreams and the store as source, and a store without the file returns no parties and no contracts

#### Scenario: Parties belong to stores
- **WHEN** a caller runs `specs parties` without `--store`
- **THEN** it fails with `INVALID_INPUT` saying parties are declared by stores, and a repository's own `openspec/parties.yaml` is never read

### Requirement: Contract declaration
The parties file MAY name specs as contracts, each with two or more of its parties. A contract SHALL name a canonical spec of the store or a spec that an active change of the store adds. It is `canonical` or `proposed` accordingly. A spec not named there SHALL NOT be a contract.

#### Scenario: Contract proposed with its change
- **WHEN** the parties file declares `game-embedding` between `site` and `game`, and `game-embedding` exists only as an ADDED delta in an active change
- **THEN** `specs parties` lists the contract as `proposed`, and after the change is archived it lists it as `canonical`

#### Scenario: Contract lists its parties
- **WHEN** `game-embedding` is a canonical contract between `site` and `game`, and a caller lists or reads the store's specs
- **THEN** that spec carries `contract: { parties: ["site", "game"] }`, and a spec not named as a contract carries `contract: null`

### Requirement: Party file validation
A parties file that is not valid YAML, uses an invalid party name or upstream, repeats an upstream, names an undeclared party in a contract, gives a contract fewer than two parties, or names a spec that is neither canonical nor added by an active change SHALL fail with `INVALID_CONFIG` naming `openspec/parties.yaml` and the problem.

#### Scenario: Contract names an unknown party
- **WHEN** a contract in the parties file lists a party the file does not declare
- **THEN** `specs parties` and `specs list` for the store fail with `INVALID_CONFIG` naming the file and the party

#### Scenario: Contract names no spec
- **WHEN** a contract names a spec that is neither canonical nor added by an active change, as after the change proposing it is abandoned
- **THEN** `specs parties` fails with `INVALID_CONFIG` naming the file and the spec

### Requirement: Contracts a repository is party to
When a repository's listing includes specs from a referenced store, each contract SHALL report the party the listed repository plays, `party: <name>`, matched by comparing each of the repository's remote URLs with each party's upstream as `repos` compares them, or `party: null` when it plays none.

#### Scenario: A repository sees its contracts
- **WHEN** a repository whose `origin` is the `site` party's upstream over SSH references the store, and a caller lists its specs
- **THEN** the referenced `game-embedding` spec reports `party: "site"`, and a contract between two other parties reports `party: null`
