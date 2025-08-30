param(
    [Parameter(Mandatory=$true)]
    [string]$StoryFile,
    
    [Parameter(Mandatory=$true)]
    [string]$ArchDocument
)

# Convert Windows paths to @ format
$StoryFileFormatted = $StoryFile -replace '^\.\\',' @' -replace '\\','/'
$ArchDocumentFormatted = $ArchDocument -replace '^\.\\',' @' -replace '\\','/'

# Validate that the story file exists
if (-not (Test-Path $StoryFile)) {
    Write-Error "Story file not found: $StoryFile"
    exit 1
}

# Validate that the architecture document exists
if (-not (Test-Path $ArchDocument)) {
    Write-Error "Architecture document not found: $ArchDocument"
    exit 1
}

Write-Host "Running story with:"
Write-Host "  Story File: $StoryFileFormatted"
Write-Host "  Architecture Document: $ArchDocumentFormatted"

claude -p "/implement-story ""$StoryFileFormatted"" ""$ArchDocumentFormatted"""
$continue = $(claude -p --output-format json "Are there any stories left to implement in $StoryFileFormatted? Only return yes or no")
Write-Host $continue
# Add your story processing logic here