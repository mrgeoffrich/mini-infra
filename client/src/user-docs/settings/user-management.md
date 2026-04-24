---
title: User Management
description: How to create, delete, and manage user accounts and passwords in Mini Infra.
tags:
  - settings
  - users
  - authentication
  - administration
---

# User Management

The **Users** page lets administrators create and manage user accounts that can log in to Mini Infra. Each user has an email address, display name, and an associated authentication method.

## Viewing Users

Navigate to **Administration → Users**. The user table shows:

| Column | Description |
|--------|-------------|
| Email | The user's login email address |
| Display Name | Human-readable name shown in the UI |
| Auth Method | How the user authenticates (e.g. `local` for password, `google` for OAuth) |
| Created | Date the account was created |

## Adding a User

1. Click **Add User**.
2. Fill in the **Email**, **Display Name**, and **Temporary Password** fields.
   - Passwords must be at least 8 characters and contain at least one letter and one number.
3. Click **Create User**.

The new user will be prompted to change their password on first login.

## Resetting a Password

If a user cannot log in, you can generate a new temporary password for them:

1. Click **Reset Password** next to the user's row.
2. Confirm the reset — a temporary password is generated and displayed.
3. Copy the temporary password using the copy icon and share it with the user securely.

The user will be required to set a new password immediately after logging in with the temporary one.

## Deleting a User

1. Click the trash icon in the user's row.
2. Confirm the deletion.

Deletion is permanent and cannot be undone. You cannot delete your own account — the delete button is disabled for the currently signed-in user.

## What to watch out for

- **Deleted users lose access immediately.** Any active sessions for the deleted account are invalidated.
- **Temporary passwords are shown once.** If you close the reset dialog before copying the password, you must reset again.
- **You cannot delete yourself.** The delete button is disabled for your own account. Another administrator must do it if needed.
- **Google OAuth users.** Accounts created via Google OAuth will show `google` as their auth method. Resetting the password does not affect Google OAuth sign-in; those users must log in via Google.
