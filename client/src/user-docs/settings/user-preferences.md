---
title: User Preferences
description: Personalising your Mini Infra experience with timezone and display settings.
category: Settings
order: 3
tags:
  - settings
  - user
  - timezone
  - preferences
---

# User Preferences

User preferences are personal settings that affect how Mini Infra displays information for your account. They don't change the system's behaviour — only what you see.

## Timezone

Navigate to your user settings by clicking the user icon in the top-right corner and selecting **Settings**, or go to **User Settings** directly.

The timezone setting controls how all dates and times are displayed throughout the app. By default, times may show in UTC or the server's timezone. Setting your local timezone ensures that:

- Dashboard timestamps show your local time.
- Backup schedule times make sense relative to your day.
- Event logs and deployment histories are easy to read.
- Container start/stop times are in a familiar reference frame.

### Changing your timezone

1. Open the timezone dropdown. It's searchable — type part of your timezone name (e.g. "New York" or "Tokyo").
2. The dropdown shows IANA timezone identifiers (e.g. `America/New_York`, `Asia/Tokyo`).
3. A preview shows the current time in the selected timezone so you can verify it's correct.
4. Click **Save Changes**.

The confirmation "All changes saved" appears when the preference is stored.

If you make a change and want to undo it before saving, click **Reset** to revert to the previously saved value.

## How timezone affects the app

The timezone preference is applied client-side. All timestamps displayed in the UI are converted to your selected timezone:

- Event start and completion times.
- Backup history timestamps.
- Deployment progress and completion times.
- Container status timestamps.
- "Last used" and "Last checked" labels.

It does not change when scheduled operations actually run. A backup scheduled for "2:00 AM Pacific" runs at 2:00 AM Pacific regardless of your display timezone — the timezone setting on the backup configuration controls execution timing.

## What to watch out for

- Your timezone preference is stored per user account. If you log in from a different browser or device, the preference carries over.
- Changing your timezone doesn't change any scheduled operations. It only affects how times are displayed to you.
- If timestamps look wrong after changing timezones, do a hard refresh in your browser to clear any cached time formatting.
