#!/bin/sh
set -e

echo "Starting Mini Infra application..."
echo "Working directory: $(pwd)"
echo "Database URL: $DATABASE_URL"

# Ensure data directory exists and is writable
mkdir -p /app/data
chmod 755 /app/data

# Load-from-backup restore swap. The app stages a downloaded backup DB at
# /app/data/restore-pending.db and drops a .restore-pending marker, then exits
# so Docker restarts us. Swap the staged DB in HERE — before Prisma opens the
# DB or runs migrate deploy — because a live process can't safely overwrite the
# WAL-mode production.db in place. Atomic (rename) and idempotent (a re-entry
# after a mid-swap crash finds the staged file already gone and just clears the
# marker).
if [ -f "/app/data/.restore-pending" ]; then
    echo "Restore marker found — swapping in restored database..."
    if [ -f "/app/data/restore-pending.db" ]; then
        mv -f /app/data/restore-pending.db /app/data/production.db
        rm -f /app/data/production.db-wal /app/data/production.db-shm
        echo "✓ Restored database swapped in"
    else
        echo "Restore marker present but staged DB missing — assuming already swapped"
    fi
    rm -f /app/data/.restore-pending
fi

# Display migration files for debugging
echo "Checking for migration files..."
if [ -d "./prisma/migrations" ]; then
    echo "Migrations directory found:"
    ls -la ./prisma/migrations/
else
    echo "WARNING: No migrations directory found!"
fi

# Run Prisma migrations with verbose output
echo "Running Prisma migrations..."
./node_modules/.bin/prisma migrate deploy

# Check if migration was successful
if [ $? -eq 0 ]; then
    echo "✓ Migrations applied successfully"
else
    echo "✗ Migration failed!"
    exit 1
fi

# Verify database file was created
if [ -f "/app/data/production.db" ]; then
    echo "✓ Database file created: /app/data/production.db"
    ls -lh /app/data/production.db
else
    echo "✗ Database file not found!"
    exit 1
fi

# Start the application
echo "Starting Node.js application..."
exec node dist/server/src/server.js
