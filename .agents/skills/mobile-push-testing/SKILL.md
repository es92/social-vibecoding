---
name: mobile-push-testing
description: Verify Homeroom mobile push notifications end to end from an exact product trigger through queued delivery, provider handoff, and rendering on a real phone. Use when testing notification kinds, push copy, preference gates, Firebase delivery, conversation notifications, or mobile-push diagnostics. Do not use for ordinary notification unit tests that do not require delivery.
---

# Mobile Push Testing

Read `references/mobile-push-testing.md` completely before performing test actions. It is the authoritative trigger matrix, diagnostic guide, sequencing plan, and cleanup checklist.

## Run an end-to-end verification

1. Confirm the phone registration, recipient preferences, two-account setup, and required app or conversation fixtures.
2. Use the exact trigger for each notification kind. Preserve the documented distinction between REST-capable and browser/WebSocket-only actions.
3. Inspect the expected notification row's nested `deliveries`; never use the typically empty top-level `deliveries` array as evidence.
4. Require server status `sent` and the human's on-device banner confirmation before reporting successful rendering. Provider handoff alone is insufficient.
5. Preserve evidence until the run is complete, then follow the cleanup checklist. Do not remove conversation membership before capturing all five conversation deliveries.

Perform API setup and calls yourself. Ask the user only for browser login approval and physical-phone observations that cannot be automated.
