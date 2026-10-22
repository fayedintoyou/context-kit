# alerts

## Purpose

How Pigeon, a fictional team chat app, tells someone that a teammate posted, so they notice what matters without being interrupted by what doesn't.

## Requirements

### Requirement: Room post without a mention
The app SHALL show a quiet dot beside a room when a teammate posts there without mentioning the user.

#### Scenario: Quiet dot for a room post
- **WHEN** a teammate posts in a room the user belongs to and does not mention them
- **THEN** a dot appears beside the room and nothing else alerts the user

### Requirement: Mention badge
The app SHALL show a number badge on a room when a direct message or a mention of the user arrives there.

#### Scenario: Badge counts mentions
- **WHEN** two teammates mention the user in one room
- **THEN** the room shows a badge reading 2

#### Scenario: Badge clears when read
- **WHEN** the user opens a room with a badge
- **THEN** the badge goes away
