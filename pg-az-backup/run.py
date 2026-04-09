#!/usr/bin/env python3

import os
import sys
import subprocess
from urllib.parse import urlparse
from backup import backup
from restore import restore
from list_databases import get_all_databases, get_user_databases_only

def prepare_postgres_variables():
    """Prepare PostgreSQL connection variables"""
    
    postgres_password = os.getenv("POSTGRES_PASSWORD","")
    postgres_host = os.getenv("POSTGRES_HOST","")
    postgres_port = os.getenv("POSTGRES_PORT", "5432")
    postgres_user = os.getenv("POSTGRES_USER","")
    postgres_extra_opts = os.getenv("POSTGRES_EXTRA_OPTS", "")
    
    # Set PGPASSWORD environment variable
    os.environ["PGPASSWORD"] = postgres_password
    
    # Prepare host options string
    postgres_host_opts = f"-h {postgres_host} -p {postgres_port} -U {postgres_user} {postgres_extra_opts}".strip()
    os.environ["POSTGRES_HOST_OPTS"] = postgres_host_opts
    
    return postgres_host_opts

def main():
    """Main function that mimics the behavior of run.sh"""
    
    try:
        # Get environment variables
        restore_var = os.getenv("RESTORE", "no")
        postgres_database = os.getenv("POSTGRES_DATABASE")
        postgres_host = os.getenv("POSTGRES_HOST")
        postgres_host_opts = prepare_postgres_variables()
        azure_connection_string = os.getenv("AZURE_STORAGE_ACCOUNT_CONNECTION_STRING")
        azure_container_name = os.getenv("AZURE_CONTAINER_NAME")
        azure_blob_name = os.getenv("AZURE_BLOB_NAME")
        backup_format = os.getenv("BACKUP_FORMAT", "plain")
        compression_level = int(os.getenv("COMPRESSION_LEVEL", "6"))
        

        
        if restore_var == "yes":
            print("Restore operation initiated")
            # Support BACKUP_FILE_URL as an alternative to AZURE_BLOB_NAME
            # (used by mini-infra's rollback manager which passes a full Azure blob URL)
            if azure_blob_name is None:
                backup_file_url = os.getenv("BACKUP_FILE_URL")
                if backup_file_url:
                    parsed = urlparse(backup_file_url)
                    # URL format: https://{account}.blob.core.windows.net/{container}/{blob_path}
                    path_parts = parsed.path.lstrip("/").split("/", 1)
                    if len(path_parts) >= 2:
                        azure_blob_name = path_parts[1]
                        print(f"Extracted blob name from BACKUP_FILE_URL: {azure_blob_name}")
                    else:
                        print(f"Error: Could not extract blob name from BACKUP_FILE_URL: {backup_file_url}", file=sys.stderr)
                        sys.exit(1)
                else:
                    print("Error: AZURE_BLOB_NAME or BACKUP_FILE_URL environment variable is required for restore operation", file=sys.stderr)
                    sys.exit(1)
            restore(postgres_database=postgres_database,
                    postgres_host_opts=postgres_host_opts,
                    azure_connection_string=azure_connection_string,
                    azure_container_name=azure_container_name,
                    azure_blob_name=azure_blob_name)
        else:
            print("Backup operation initiated")
            if postgres_database is None:
                print("Error: POSTGRES_DATABASE environment variable is required for backup operation", file=sys.stderr)
                sys.exit(1)
            backup(
                postgres_database=postgres_database,
                postgres_host=postgres_host,
                postgres_host_opts=postgres_host_opts,
                azure_connection_string=azure_connection_string,
                azure_container_name=azure_container_name,
                azure_blob_name=azure_blob_name,
                backup_format=backup_format,
                compression_level=compression_level
            )

    except KeyboardInterrupt:
        print("\nOperation cancelled by user", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
