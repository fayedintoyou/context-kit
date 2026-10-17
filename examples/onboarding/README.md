# Onboarding (fictional example)

This hub demonstrates the same format applied to a business domain. The systems
below are invented and have no configured access or verified implementation.

The identity service creates an account and emits an account-created event. The
welcome service consumes the event and schedules a welcome message. Each service
lives in a separate repository maintained by its owning team.

## Where to look

- Account creation rules: identity repository, account creation handler.
- Event shape and compatibility: identity repository, event schema.
- Missing welcome messages: welcome repository, consumer and retry behavior.
- A change spanning the event and consumer: inspect both repositories and plan
  compatibility before implementation; consider independent plan review.

When adapting this example, replace these prose pointers with real source links
and record the revision inspected. Do not treat this example as evidence about
any real business system. The hub documents a domain; source repositories remain
authoritative for implementation behavior.
