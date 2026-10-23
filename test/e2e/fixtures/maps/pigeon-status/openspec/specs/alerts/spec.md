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

### Requirement: Desktop pop-up
The app SHALL show a pop-up for a direct message or a mention while the user is at a desktop or laptop.

#### Scenario: Pop-up at your desk
- **WHEN** a teammate mentions the user while their laptop is active
- **THEN** a pop-up shows the message on the laptop

### Requirement: Single pop-up
The app SHALL show a pop-up on one device only: the one the user used last.

#### Scenario: Laptop and tablet both open
- **WHEN** a teammate mentions the user while Pigeon is open on their laptop and their tablet, and they used the laptop last
- **THEN** only the laptop shows a pop-up

### Requirement: Away from your desk
The app SHALL tap the user's watch for a direct message or a mention when no desktop or laptop is active.

#### Scenario: Watch tap when away
- **WHEN** a teammate mentions the user and none of their computers is active
- **THEN** their watch taps their wrist once
