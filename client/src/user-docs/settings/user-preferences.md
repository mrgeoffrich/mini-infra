---
title: User Preferences
description: How to configure personal settings like timezone in Mini Infra.
tags:
  - settings
  - user
  - timezone
  - preferences
---

# User Preferences

The **User Settings** page at [/user/settings](/user/settings) lets you configure personal preferences that apply to your account only.

## Timezone

The **Timezone** field controls how dates and times are displayed throughout the Mini Infra interface for your account.

To change your timezone:

1. Go to [User Settings](/user/settings).
2. Click the **Timezone** dropdown to open a searchable list of timezones.
3. Type to search — for example, type `London`, `New_York`, or `Sydney`.
4. Select your timezone from the list.
5. A preview shows the current local time in the selected timezone.
6. Click **Save Changes** to apply.

The **Reset** button appears if you have made changes. Click it to discard unsaved changes and revert to the last saved timezone.

A success message ("All changes saved" with a checkmark) confirms when your preferences are saved.

## What to watch out for

- Timezone is a per-user setting. Other users on the same Mini Infra instance have their own timezone preferences.
- Changing your timezone affects how timestamps are displayed in the UI but does not change when scheduled operations run. Backup schedules and other cron jobs use their own timezone settings configured separately.
- If you are unsure of your timezone string, search by city name — Mini Infra's timezone list uses IANA timezone identifiers (e.g., `America/New_York`, `Europe/London`).
