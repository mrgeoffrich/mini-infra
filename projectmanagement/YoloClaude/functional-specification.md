# Claude Story Runner - Web Interface Functional Specification

## Overview

The Claude Story Runner web interface is a spage that allows users to execute Claude Code over a set of stories from a Git repository. The application provides real-time feedback and progress tracking throughout the execution process. I already have the code to run claude-code and stream the feedback to a console.

## User Personas

### Primary User: Software Developer
- Fit into existing UI framework.
- Values real-time feedback and progress visibility
- May use mobile devices for monitoring long-running processes

## Core User Flow

### 1. Initial Page Load
**Trigger**: User navigates to the page - it allows someone to create a New job
**Expected Behavior**:
- Application loads with a clean, responsive interface
- Main form is displayed with all required input fields
- Page title shows "Yolo Claude"
- Subtitle explains the application's purpose
- All form fields are empty and ready for input

### 2. Repository Configuration
**Trigger**: User begins filling out the form  
**Steps**:
1. User enters **Repository URL** in the first field
   - Accepts GitHub HTTPS URLs (e.g., `https://github.com/user/repo`)
   - Accepts GitHub SSH URLs (e.g., `git@github.com:user/repo.git`)
   - Shows helper text explaining supported formats
   - Required field validation

2. User enters **GitHub Personal Access Token**
   - Password field type (masked input)
   - Required field validation
   - Helper text explains token needs repository access permissions
   - Shows security notice about encryption in transit

**Validation Rules**:
- Repository URL must be a valid URL format
- GitHub token is required (non-empty string)
- Real-time validation feedback with error messages

### 3. File Path Specification
**Trigger**: User continues to file path fields  
**Steps**:
1. User enters **Story File Path**
   - Text input for path relative to repository root
   - Placeholder example: `stories/user-stories.md`
   - Helper text explains it should be path within the repository
   - Required field validation

2. User enters **Architecture Document Path**
   - Text input for path relative to repository root
   - Placeholder example: `docs/architecture.md`
   - Helper text explains it should be path within the repository
   - Required field validation

**Validation Rules**:
- Both paths are required
- No validation of actual file existence (validated after cloning)

### 4. Optional Configuration
**Trigger**: User configures additional options  
**Steps**:
1. **Branch Prefix** (mandatory)
   - Used for naming story branches during execution

2. **Feature Branch Name** (mandatory)
   - Required and creates feature branch as base for all stories

### 5. Form Submission
**Trigger**: User clicks "YOLO" button  
**Pre-conditions**:
- All required fields are filled
- Button is enabled (not disabled)

**Expected Behavior**:
1. Job ID is created and user is redirected to a URL including this ID.
2. This job page shows the progress of the job streaming back.


### 6. Job Initialization
**Trigger**: Form submission is processed  
**Backend Process**:
1. Server validates input parameters
2. Creates new session with unique ID
3. Adds job to processing queue
4. Returns session information to frontend
5. When the job starts it should return a unique ID and the user should get redirect there to watch.

**Frontend Response**:
1. Job ID is created and user is redirected to a URL including this ID.
2. This job page shows the progress of the job streaming back.
3. The job page also show the usual left menu so people can create another job.

### 7. Claude Code Execution Phase
1. Look at the code in @projectmanagement/YoloClaude/oldsrc - that process is what needs to run.
 and what should stream back.

**Real-time Updates Include**:
- Logs from the running process

#### 7. Job List Page
1. All jobs a user has created should be visible in a list on the jobs page.
2. When a job finishes it should get marked as finished visible on this page.
3. This page should have no other functionality other than to link off to the running job.
4. We can think about cleaning them up later.