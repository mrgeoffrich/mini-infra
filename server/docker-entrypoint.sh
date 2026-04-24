#!/bin/sh
set -e

echo "Starting Mini Infra application..."
echo "Working directory: $(pwd)"
echo "Database URL: $DATABASE_URL"

# Ensure data directory exists and is writable
mkdir -p /app/data
chmod 755 /app/data

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
