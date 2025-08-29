# Mini Infra - Functional Specification

## Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using Traefik, and Cloudflare tunnel monitoring.

## Core Architecture

- **Target Environment**: Single Docker host
- **Storage**: Local SQLite database for runtime state and configuration
- **Authentication**: OAuth with Google, API key support for webhooks

## Feature Specifications

### 1. Docker Container Management

#### 1.1 Container Overview Dashboard
- **Purpose**: Read-only view of all running containers on the host
- **Display Information**:
  - Container name
  - Status (running, stopped, restarting, etc.)
  - Image name and tag
  - Exposed ports
  - Mounted volumes
  - Container IP address
  - Creation timestamp
- **Real-time Updates**: Container status updates via polling
- **UI**: Tabular view with filtering and sorting capabilities

### 2. PostgreSQL Database Management

#### 2.1 Database Discovery
- **Functionality**: Allow storage of database connection strings
- **Support**: Multiple PostgreSQL instances and databases per instance

#### 2.2 Backup Configuration
- **Backup Destinations**: Azure Storage Account integration
- **Trigger Types**:
  - Manual backup (on-demand)
  - Scheduled backup (cron expressions)
- **Configuration Storage**: SQLite database
- **Per-Database Settings**:
  - Backup schedule
  - Azure storage container/path
  - Database connection details
  - Backup retention (future consideration)

#### 2.3 Backup Operations
- **Manual Backup**: One-click backup execution
- **Scheduled Backup**: Automated execution based on cron schedule
- **Backup Format**: Standard PostgreSQL dump files
- **Progress Tracking**: Real-time backup progress via polling

#### 2.4 Restore Operations
- **Source**: Azure Storage Account backup files
- **UI**: Browse available backup files with metadata
- **Target**: Select target database for restoration
- **Confirmation**: Multi-step confirmation process for safety

### 3. Zero-Downtime Deployment System

#### 3.1 Traefik Integration
- **Configuration Management**: Store and manage Traefik routing rules
- **Route Configuration**:
  - Service discovery rules
  - Load balancing settings
  - Health check endpoints

#### 3.2 Blue-Green Deployment Process
- **Trigger**: Manual UI trigger or webhook API call
- **Automated Process**:
  1. Deploy new container with staging labels
  2. Execute automated health check against configured endpoint
  3. If health check passes, update Traefik configuration to route traffic to new container
  4. Monitor new container stability
  5. Stop and remove old container
  6. Log all deployment steps and status

#### 3.3 Deployment Configuration
- **Per-Application Settings**:
  - Docker image and tag
  - Container configuration (ports, volumes, environment variables)
  - Health check endpoint and criteria
  - Traefik routing rules
  - Rollback procedures

#### 3.4 Health Check System
- **Endpoint Configuration**: HTTP endpoint URL and expected response
- **Validation Criteria**: HTTP status codes, response body matching
- **Timeout Settings**: Configurable timeout and retry logic
- **Failure Handling**: Automatic rollback on health check failure

### 4. Cloudflare Tunnel Management

#### 4.1 Tunnel Visibility
- **Purpose**: Read-only monitoring of existing Cloudflare tunnels
- **Display Information**:
  - Tunnel names and IDs
  - Connected hostnames
  - Target applications/services
  - Tunnel health status
  - Connection status

#### 4.2 Cloudflare API Integration
- **Authentication**: Cloudflare API token
- **Operations**: Read-only access to tunnel configuration
- **Real-time Monitoring**: Periodic health checks and status updates
- **NPM Library**: Use the cloudflare npm library Context7

### 5. Authentication and Authorization

#### 5.1 User Authentication
- **Primary Method**: OAuth 2.0 with Google
- **Session Management**: Secure session handling
- **User Information**: Store basic user profile data

#### 5.2 API Authentication
- **Webhook Support**: API key-based authentication for automated triggers
- **Key Management**: Generate and manage API keys through UI
- **Scope**: API keys limited to deployment trigger operations

#### 5.3 Authorization
- **Permission Model**: Single permission level (authenticated users have full access)
- **Team Support**: Support for small team usage (multiple Google accounts)

### 6. Activity Logging and Monitoring

#### 6.1 Activity Log
- **Tracked Activities**:
  - Deployment operations (start, progress, completion, failure)
  - Backup operations (scheduled and manual)
  - Restore operations
  - Configuration changes
  - Authentication events
  - Health check results

#### 6.2 Log Storage and Retrieval
- **Storage**: SQLite database with structured logging
- **UI**: Detailed log viewer with filtering and search
- **Export**: Ability to export logs for external analysis

#### 6.3 Real-time Updates
- **Live Logs**: Viewing of log entries using polling
- **Status Updates**: Progress updates for long-running operations

### 7. User Interface Design

#### 7.1 Dashboard Structure
- **Multi-page Application**: Separate pages for different functional areas
- **Navigation**: Primary navigation menu with the following sections:
  - Container Overview
  - Database Management
  - Deployment Management
  - Cloudflare Tunnels
  - Activity Logs
  - Settings

#### 7.2 Real-time Features
- **Visual Indicators**: Status indicators and progress bars
- **Notifications**: In-app notifications for completed operations

## Technical Requirements

### 7.1 Data Storage
- **Primary Database**: SQLite for all configuration and runtime state
- **Backup Storage**: Azure Storage Account integration
- **Data Persistence**: All configuration survives application restarts

### 7.2 External Integrations
- **Docker API**: Docker Engine API for container management
- **Traefik API**: Direct integration for load balancer configuration
- **Cloudflare API**: Read-only access for tunnel monitoring
- **Azure Storage API**: Backup and restore operations
- **Google OAuth API**: User authentication

### 7.3 Security Considerations
- **Authentication**: Secure OAuth implementation
- **API Security**: Secure API key generation and validation
- **Data Protection**: Encrypted storage for sensitive configuration
- **Network Security**: HTTPS enforcement for all communications

## 8. Settings and Configuration Management

### 8.1 Settings storage and verification

- **Cloudflare API Key**: Store and verify the key works
- **Docker Host**: Store and verift docker host location



## Future Considerations

- Git integration for configuration versioning
- Notification system (email, Slack, webhooks)
- Backup retention policies
- Advanced deployment strategies
- SSL certificate management
- Enhanced monitoring and alerting
- Multi-host support (beyond single Docker host)

## Success Criteria

- **Reliability**: Zero-downtime deployments execute successfully 99% of the time
- **Usability**: Team members can perform common operations without documentation
- **Performance**: Real-time updates respond within 1 second
- **Security**: All authentication and authorization requirements met
- **Monitoring**: Complete audit trail for all infrastructure operations