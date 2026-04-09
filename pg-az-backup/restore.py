#!/usr/bin/env python3
"""
PostgreSQL restore script that downloads a backup from Azure Blob Storage and restores it.
Python equivalent of restore.sh
"""

import os
import sys
import subprocess
import gzip
import shutil
from datetime import datetime, timezone
from pathlib import Path
from azure.storage.blob import BlobServiceClient


def run_command(command, shell=True, check=True):
    """Run a shell command and handle errors."""
    try:
        result = subprocess.run(
            command, 
            shell=shell, 
            check=check, 
            capture_output=True, 
            text=True
        )
        return result
    except subprocess.CalledProcessError as e:
        print(f"Command failed: {command}", file=sys.stderr)
        print(f"Error: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def database_exists(postgres_host_opts, database_name):
    """Check if a database exists."""
    try:
        cmd = f'psql {postgres_host_opts} -lqt'
        result = subprocess.run(
            cmd,
            shell=True,
            check=True,
            capture_output=True,
            text=True
        )
        # Parse the output to find the database
        lines = result.stdout.strip().split('\n')
        for line in lines:
            if line.strip():
                db_name = line.split('|')[0].strip()
                if db_name == database_name:
                    return True
        return False
    except subprocess.CalledProcessError:
        # If we can't list databases, assume it doesn't exist
        return False


def create_database_if_not_exists(postgres_host_opts, database_name):
    """Create a database if it doesn't exist."""
    if database_exists(postgres_host_opts, database_name):
        print(f"Database '{database_name}' already exists")
        return False
    else:
        print(f"Database '{database_name}' does not exist, creating it...")
        try:
            cmd = f'psql {postgres_host_opts} -c "CREATE DATABASE \\"{database_name}\\""'
            run_command(cmd)
            print(f"Successfully created database '{database_name}'")
            return True
        except Exception as e:
            print(f"Failed to create database '{database_name}': {e}", file=sys.stderr)
            sys.exit(1)




def restore(postgres_database,
        postgres_host_opts,
        azure_connection_string,
        azure_container_name,
        azure_blob_name):
    """Main restore function."""
    restore_start_time = datetime.now()
    print(f"[{restore_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting restore process")
    print(f"Target database: {postgres_database}")
    print(f"Source blob: {azure_blob_name}")
    print(f"Azure container: {azure_container_name}")
    
    try:
        # Create data directory
        data_dir = Path('/etc/data')
        data_dir.mkdir(parents=True, exist_ok=True)
        os.chdir(data_dir)
        
        # Get required environment variables
        drop_public = os.environ.get('DROP_PUBLIC', '')

        if not azure_connection_string or not azure_container_name or not azure_blob_name or not postgres_database:
            print("Missing required environment variables", file=sys.stderr)
            sys.exit(1)

        # Check if database exists and create it if necessary
        create_database_if_not_exists(postgres_host_opts, postgres_database)

        download_start_time = datetime.now()
        print(f"[{download_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting download from Azure")
        print(f"Fetching '{azure_blob_name}' from container '{azure_container_name}'")
        
        # Download backup file using Azure Python SDK
        try:
            # Create BlobServiceClient using connection string
            blob_service_client = BlobServiceClient.from_connection_string(azure_connection_string)
            
            # Get blob client for the backup file
            blob_client = blob_service_client.get_blob_client(
                container=azure_container_name, 
                blob=azure_blob_name
            )
            
            # Download the backup file
            local_filename = 'downloaded_backup'
            print(f"Downloading to local file: {local_filename}")
            with open(local_filename, 'wb') as f:
                download_stream = blob_client.download_blob()
                content = download_stream.readall()
                f.write(content)
                
            download_end_time = datetime.now()
            download_duration = download_end_time - download_start_time
            file_size_mb = len(content) / (1024 * 1024)
            print(f"[{download_end_time.strftime('%Y-%m-%d %H:%M:%S')}] Download completed in {download_duration.total_seconds():.2f} seconds")
            print(f"Downloaded file size: {file_size_mb:.2f} MB")
                
        except Exception as e:
            print(f"Failed to download backup file: {e}", file=sys.stderr)
            sys.exit(1)
        
        # Handle different backup formats based on file extension
        processing_start_time = datetime.now()
        print(f"[{processing_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Processing backup file")
        
        if azure_blob_name.endswith('.sql.gz'):
            # Decompress gzipped SQL file
            print("Detected format: Gzipped SQL (.sql.gz)")
            print("Decompressing backup file...")
            with gzip.open(local_filename, 'rb') as f_in:
                with open('dump.sql', 'wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)
            restore_file = 'dump.sql'
            restore_method = 'psql'
        elif azure_blob_name.endswith('.backup') or azure_blob_name.endswith('.dump'):
            # Custom format - use pg_restore
            print(f"Detected format: PostgreSQL custom format ({azure_blob_name.split('.')[-1]})")
            restore_file = local_filename
            restore_method = 'pg_restore'
        elif azure_blob_name.endswith('.tar') or azure_blob_name.endswith('.tar.gz'):
            # Tar format - use pg_restore
            print(f"Detected format: PostgreSQL tar format ({azure_blob_name.split('.')[-1]})")
            restore_file = local_filename
            restore_method = 'pg_restore'
        elif azure_blob_name.endswith('.sql'):
            # Plain SQL
            print("Detected format: Plain SQL (.sql)")
            restore_file = local_filename
            restore_method = 'psql'
        else:
            # Assume plain SQL
            print(f"Unknown format, assuming plain SQL: {azure_blob_name}")
            restore_file = local_filename
            restore_method = 'psql'
            
        processing_end_time = datetime.now()
        processing_duration = processing_end_time - processing_start_time
        print(f"File processing completed in {processing_duration.total_seconds():.2f} seconds")
        print(f"Will use {restore_method} for restoration")
        
        # Handle DROP_PUBLIC option
        if drop_public == "yes":
            print("Recreating the public schema")
            cmd = f'psql {postgres_host_opts} -d {postgres_database} -c "drop schema public cascade; create schema public;"'
            run_command(cmd)
        
        if drop_public == "create":
            print("Creating the new database")
            cmd = f'psql {postgres_host_opts} -c "create database \\"{postgres_database}\\""'
            run_command(cmd)
        
        # Restore the database
        restore_db_start_time = datetime.now()
        print(f"[{restore_db_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting database restoration")
        print(f"Restoring '{azure_blob_name}' to database '{postgres_database}' using {restore_method}")
       
        # Restore based on file type
        if restore_method == 'psql':
            # Use psql for SQL files
            cmd = f'psql {postgres_host_opts} -d {postgres_database}'
            print(f"psql command: {cmd}")
            with open(restore_file, 'r') as dump_file:
                try:
                    result = subprocess.run(
                        cmd,
                        shell=True,
                        stdin=dump_file,
                        check=True,
                        capture_output=True,
                        text=True
                    )
                    if result.stdout:
                        print(f"psql output: {result.stdout}")
                except subprocess.CalledProcessError as e:
                    print(f"Database restore failed with psql: {e.stderr}", file=sys.stderr)
                    print(f"Return code: {e.returncode}", file=sys.stderr)
                    sys.exit(1)
        else:
            # Use pg_restore for binary formats (custom, tar)
            cmd = f'pg_restore {postgres_host_opts} -d {postgres_database} {restore_file}'
            print(f"pg_restore command: {cmd}")
            try:
                result = subprocess.run(
                    cmd,
                    shell=True,
                    check=True,
                    capture_output=True,
                    text=True
                )
                if result.stdout:
                    print(f"pg_restore output: {result.stdout}")
            except subprocess.CalledProcessError as e:
                print(f"Database restore failed with pg_restore: {e.stderr}", file=sys.stderr)
                print(f"Return code: {e.returncode}", file=sys.stderr)
                sys.exit(1)
        
        restore_db_end_time = datetime.now()
        restore_duration = restore_db_end_time - restore_db_start_time
        total_duration = restore_db_end_time - restore_start_time
        print(f"[{restore_db_end_time.strftime('%Y-%m-%d %H:%M:%S')}] Database restoration completed in {restore_duration.total_seconds():.2f} seconds")
        
        # Clean up temporary files
        print("Cleaning up temporary files...")
        cleanup_count = 0
        if os.path.exists(local_filename):
            os.remove(local_filename)
            cleanup_count += 1
            print(f"Removed: {local_filename}")
        if os.path.exists('dump.sql'):
            os.remove('dump.sql')
            cleanup_count += 1
            print(f"Removed: dump.sql")
        print(f"Cleaned up {cleanup_count} temporary files")
            
        print(f"[{restore_db_end_time.strftime('%Y-%m-%d %H:%M:%S')}] Restore process completed successfully in {total_duration.total_seconds():.2f} seconds")
        
    except KeyboardInterrupt:
        print("\nRestore interrupted by user", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        error_time = datetime.now()
        total_duration = error_time - restore_start_time if 'restore_start_time' in locals() else 0
        print(f"[{error_time.strftime('%Y-%m-%d %H:%M:%S')}] Unexpected error after {total_duration:.2f} seconds: {e}", file=sys.stderr)
        print(f"Error type: {type(e).__name__}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    print("no")
