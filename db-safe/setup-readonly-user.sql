-- ============================================================================
-- Setup read-only PostgreSQL user for db-safe CLI
-- ============================================================================
-- 
-- Run this script on both STAGING and PRODUCTION databases.
-- This creates a user that can only SELECT - no INSERT, UPDATE, DELETE.
--
-- Usage:
--   psql $DATABASE_URL -f ~/Documents/Development/tools/db-safe/setup-readonly-user.sql
--
-- After running, add to Infisical:
--   DATABASE_URL_READONLY = postgres://slack_readonly:<password>@<host>/<db>
--
-- ============================================================================

-- Generate a secure random password (replace this!)
-- You can generate one with: openssl rand -base64 32
\set password 'REPLACE_WITH_SECURE_PASSWORD'

-- Create the read-only user
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'slack_readonly') THEN
        CREATE ROLE slack_readonly WITH LOGIN PASSWORD :'password';
    END IF;
END
$$;

-- Grant connect to database
GRANT CONNECT ON DATABASE CURRENT_DATABASE() TO slack_readonly;

-- Grant usage on public schema
GRANT USAGE ON SCHEMA public TO slack_readonly;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO slack_readonly;

-- Grant SELECT on all future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO slack_readonly;

-- Grant SELECT on all sequences (needed for some queries)
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO slack_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO slack_readonly;

-- Verify permissions
\echo ''
\echo '============================================'
\echo 'Read-only user created successfully!'
\echo '============================================'
\echo ''
\echo 'User: slack_readonly'
\echo 'Permissions: SELECT only (no INSERT, UPDATE, DELETE)'
\echo ''
\echo 'Next steps:'
\echo '1. Copy the password you set above'
\echo '2. Create connection string: postgres://slack_readonly:<password>@<host>/<db>'
\echo '3. Add to Infisical as DATABASE_URL_READONLY for this environment'
\echo ''
