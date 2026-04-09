#!/usr/bin/env python3
"""
Standalone script to list all databases from a PostgreSQL server
"""

import os
import sys
import subprocess

def get_all_databases(postgres_host_opts=None):
    """
    Get all databases from PostgreSQL server and return them as an array
    
    Args:
        postgres_host_opts (str): PostgreSQL connection options string
                                 If None, will be constructed from environment variables
    
    Returns:
        list: Array of database names
    """
    
    if postgres_host_opts is None:
        # Prepare connection options from environment variables
        postgres_password = os.getenv("POSTGRES_PASSWORD", "")
        postgres_host = os.getenv("POSTGRES_HOST", "localhost")
        postgres_port = os.getenv("POSTGRES_PORT", "5432")
        postgres_user = os.getenv("POSTGRES_USER", "postgres")
        postgres_extra_opts = os.getenv("POSTGRES_EXTRA_OPTS", "")
        
        # Set PGPASSWORD environment variable
        if postgres_password:
            os.environ["PGPASSWORD"] = postgres_password
        
        # Prepare host options string
        postgres_host_opts = f"-h {postgres_host} -p {postgres_port} -U {postgres_user} {postgres_extra_opts}".strip()
    
    try:
        # Use psql to list all databases
        # -t = tuples only (no headers)
        # -A = unaligned output  
        # -c = execute command
        # Query excludes template databases which are system databases
        command = f'psql {postgres_host_opts} -t -A -c "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;"'
        
        print(f"Executing command: {command}")
        
        result = subprocess.run(
            command,
            shell=True,
            check=True,
            capture_output=True,
            text=True
        )
        
        # Split the output by newlines and filter out empty lines
        databases = [db.strip() for db in result.stdout.split('\n') if db.strip()]
        
        print(f"Found {len(databases)} databases:")
        for i, db in enumerate(databases, 1):
            print(f"  {i}. {db}")
        
        return databases
        
    except subprocess.CalledProcessError as e:
        print(f"Error getting database list: {e}", file=sys.stderr)
        print(f"Command stderr: {e.stderr}", file=sys.stderr)
        print(f"Command stdout: {e.stdout}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"Unexpected error getting database list: {e}", file=sys.stderr)
        return []

def get_user_databases_only(postgres_host_opts=None):
    """
    Get only user-created databases (excludes system databases)
    
    Args:
        postgres_host_opts (str): PostgreSQL connection options string
    
    Returns:
        list: Array of user database names
    """
    
    if postgres_host_opts is None:
        # Use same logic as get_all_databases to prepare connection
        postgres_password = os.getenv("POSTGRES_PASSWORD", "")
        postgres_host = os.getenv("POSTGRES_HOST", "localhost")
        postgres_port = os.getenv("POSTGRES_PORT", "5432")
        postgres_user = os.getenv("POSTGRES_USER", "postgres")
        postgres_extra_opts = os.getenv("POSTGRES_EXTRA_OPTS", "")
        
        if postgres_password:
            os.environ["PGPASSWORD"] = postgres_password
            
        postgres_host_opts = f"-h {postgres_host} -p {postgres_port} -U {postgres_user} {postgres_extra_opts}".strip()
    
    try:
        # Query that excludes system databases
        command = f'''psql {postgres_host_opts} -t -A -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres', 'template0', 'template1') ORDER BY datname;"'''
        
        result = subprocess.run(
            command,
            shell=True,
            check=True,
            capture_output=True,
            text=True
        )
        
        databases = [db.strip() for db in result.stdout.split('\n') if db.strip()]
        
        print(f"Found {len(databases)} user databases:")
        for i, db in enumerate(databases, 1):
            print(f"  {i}. {db}")
        
        return databases
        
    except subprocess.CalledProcessError as e:
        print(f"Error getting user database list: {e}", file=sys.stderr)
        print(f"Command stderr: {e.stderr}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"Unexpected error getting user database list: {e}", file=sys.stderr)
        return []

def main():
    """Main function for standalone execution"""
    print("PostgreSQL Database Lister")
    print("=" * 40)
    
    print("\nAll databases (excluding templates):")
    all_dbs = get_all_databases()
    
    print("\nUser databases only (excluding system databases):")
    user_dbs = get_user_databases_only()
    
    if all_dbs:
        print(f"\nDatabase array: {all_dbs}")
    else:
        print("\nNo databases found or connection failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
