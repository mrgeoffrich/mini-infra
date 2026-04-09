#!/usr/bin/env python3
"""
PostgreSQL backup script that creates a dump and uploads it to Azure Blob Storage.
"""

import os
import shlex
import sys
import subprocess
import gzip
from datetime import datetime
from pathlib import Path
from azure.storage.blob import BlobServiceClient
from utils import run_command


def backup(postgres_database,
        postgres_host,
        postgres_host_opts,
        azure_connection_string,
        azure_container_name,
        azure_blob_name,
        backup_format='plain',
        compression_level=6):
    """Main backup function."""
    backup_start_time = datetime.now()
    print(f"[{backup_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting backup process")
    print(f"Database: {postgres_database}")
    print(f"Host: {postgres_host}")
    print(f"Backup format: {backup_format}")
    print(f"Compression level: {compression_level}")
    print(f"Azure blob: {azure_blob_name}")
    print(f"Azure container: {azure_container_name}")
    print("Setting up working directory")

    # Create and change to working directory
    data_dir = Path("/etc/data")
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(data_dir)

    print(f"Creating {backup_format} format dump of '{postgres_database}' database from '{postgres_host}'...")

    # Get backup format and compression level
    backup_format = backup_format.lower()
    quoted_db = shlex.quote(postgres_database)

    # Create PostgreSQL dump command based on format
    if backup_format == 'custom':
        # Custom format with built-in compression
        pg_dump_cmd = f"pg_dump {postgres_host_opts} --format=custom --compress={compression_level} {quoted_db}"
        dump_filename = "backup.dump"
        final_filename = "backup.dump"
    elif backup_format == 'directory':
        # Directory format with built-in compression
        pg_dump_cmd = f"pg_dump {postgres_host_opts} --format=directory --compress={compression_level} --file=dump_dir {quoted_db}"
        dump_filename = "dump_dir"
        final_filename = "dump.tar.gz"
    elif backup_format == 'tar':
        # Tar format with built-in compression
        pg_dump_cmd = f"pg_dump {postgres_host_opts} --format=tar --compress={compression_level} {quoted_db}"
        dump_filename = "dump.tar"
        final_filename = "dump.tar"
    else:
        # Plain SQL format (default) - we'll handle gzip compression manually
        pg_dump_cmd = f"pg_dump {postgres_host_opts} {quoted_db}"
        dump_filename = "dump.sql.gz"
        final_filename = "dump.sql.gz"

    dump_start_time = datetime.now()
    print(f"[{dump_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting pg_dump process")
    print(f"Command: {pg_dump_cmd}")

    try:
        if backup_format == 'plain':
            # For plain format, we handle gzip compression manually
            pg_dump_process = subprocess.Popen(
                pg_dump_cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False  # Binary mode for gzip
            )

            if pg_dump_process.stdout is None:
                print("Error: Failed to create stdout pipe for pg_dump", file=sys.stderr)
                sys.exit(1)

            stdout = pg_dump_process.stdout
            stderr = pg_dump_process.stderr

            with open(dump_filename, "wb") as dump_file:
                with gzip.GzipFile(fileobj=dump_file, mode="wb", compresslevel=compression_level) as gz_file:
                    for chunk in iter(lambda: stdout.read(8192), b""):
                        gz_file.write(chunk)

            # Close stdout before waiting to avoid deadlocks
            stdout.close()

            # Wait for process and check return code
            return_code = pg_dump_process.wait()
            if return_code != 0:
                error_output = stderr.read().decode() if stderr else "Unknown error"
                stderr.close() if stderr else None
                print(f"pg_dump failed with return code {return_code}: {error_output}", file=sys.stderr)
                sys.exit(1)

            if stderr:
                stderr.close()

            dump_end_time = datetime.now()
            dump_duration = dump_end_time - dump_start_time
            print(f"[{dump_end_time.strftime('%Y-%m-%d %H:%M:%S')}] pg_dump completed in {dump_duration.total_seconds():.2f} seconds")

        elif backup_format == 'directory':
            # For directory format, run pg_dump then tar/gzip the directory
            run_command(pg_dump_cmd)

            dump_end_time = datetime.now()
            dump_duration = dump_end_time - dump_start_time
            print(f"[{dump_end_time.strftime('%Y-%m-%d %H:%M:%S')}] pg_dump completed in {dump_duration.total_seconds():.2f} seconds")

            # Tar and gzip the directory
            print(f"Creating tar archive: {final_filename}")
            tar_start_time = datetime.now()
            tar_cmd = f"tar -czf {final_filename} -C . {dump_filename}"
            print(f"Tar command: {tar_cmd}")
            run_command(tar_cmd)

            tar_end_time = datetime.now()
            tar_duration = tar_end_time - tar_start_time
            print(f"[{tar_end_time.strftime('%Y-%m-%d %H:%M:%S')}] Tar archive created in {tar_duration.total_seconds():.2f} seconds")

        else:
            # For custom and tar formats, pg_dump handles compression internally
            # Need to specify output file for custom format
            if backup_format == 'custom':
                final_cmd = f"{pg_dump_cmd} --file={dump_filename}"
            else:
                final_cmd = f"{pg_dump_cmd} > {dump_filename}"

            print(f"Final command: {final_cmd}")
            run_command(final_cmd)

            dump_end_time = datetime.now()
            dump_duration = dump_end_time - dump_start_time
            print(f"[{dump_end_time.strftime('%Y-%m-%d %H:%M:%S')}] pg_dump completed in {dump_duration.total_seconds():.2f} seconds")

    except Exception as e:
        print(f"Error creating database dump: {e}", file=sys.stderr)
        sys.exit(1)

    # Get file size for logging
    try:
        file_size = os.path.getsize(final_filename)
        file_size_mb = file_size / (1024 * 1024)
        print(f"Backup file size: {file_size_mb:.2f} MB")
    except OSError:
        print("Could not determine backup file size")

    upload_start_time = datetime.now()
    print(f"[{upload_start_time.strftime('%Y-%m-%d %H:%M:%S')}] Starting upload to Azure Blob Storage")
    print(f"Uploading '{final_filename}' as '{azure_blob_name}' to container '{azure_container_name}'")

    # Upload using Azure Python SDK
    try:
        # Create BlobServiceClient using connection string
        blob_service_client = BlobServiceClient.from_connection_string(azure_connection_string)

        # Get blob client for the backup file
        blob_client = blob_service_client.get_blob_client(
            container=azure_container_name,
            blob=azure_blob_name
        )

        # Upload the dump file
        with open(final_filename, "rb") as data:
            blob_client.upload_blob(data, overwrite=True)

        upload_end_time = datetime.now()
        upload_duration = upload_end_time - upload_start_time
        total_duration = upload_end_time - backup_start_time
        print(f"[{upload_end_time.strftime('%Y-%m-%d %H:%M:%S')}] Successfully uploaded '{azure_blob_name}' to Azure Blob Storage")
        print(f"Upload completed in {upload_duration.total_seconds():.2f} seconds")
        print(f"Total backup process completed in {total_duration.total_seconds():.2f} seconds")

    except Exception as e:
        print(f"Error uploading to Azure Blob Storage: {e}", file=sys.stderr)
        sys.exit(1)

    # Clean up local dump files
    try:
        if os.path.isdir(dump_filename):
            import shutil
            shutil.rmtree(dump_filename)
        elif os.path.exists(dump_filename) and dump_filename != final_filename:
            os.remove(dump_filename)
        if os.path.exists(final_filename):
            os.remove(final_filename)
    except OSError as e:
        print(f"Warning: failed to clean up temp files: {e}")

    print("SQL backup uploaded successfully")


if __name__ == "__main__":
    print("no")
