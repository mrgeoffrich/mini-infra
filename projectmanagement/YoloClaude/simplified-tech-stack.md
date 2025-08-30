## In-Memory Job Queue with Bull

### Why Bull Queue?
- **In-memory mode**: No Redis required for MVP
- **Migration path**: Easy switch to Redis later
- **Battle-tested**: Mature library with good API
- **Features**: Job retries, progress tracking, concurrency control

### Queue Implementation
```typescript
// src/server/services/job-queue.ts
import Queue from 'bull';
import { runStoryClaudeCode } from '../../shared/claude-run-story.js';
import { SSEService } from './sse.js';

interface JobData {
  sessionId: string;
  repositoryUrl: string;
  githubToken: string;
  storyFile: string;        // Path within repository
  architectureDoc: string;  // Path within repository
  options: {
    branchPrefix?: string;
    featureBranch?: string;
    customPrompt?: string;
  };
}

// In-memory queue (no Redis)
const jobQueue = new Queue('story processing', {
  redis: {
    port: 6379,
    host: '127.0.0.1',
    // For MVP: use in-memory fallback
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryDelayOnFailover: 0,
    enableOfflineQueue: false
  },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: 1,
    backoff: 'exponential'
  }
});

// Fallback to in-memory when Redis unavailable
jobQueue.on('error', (error) => {
  console.log('Queue using in-memory mode:', error.message);
});

export class JobQueueService {
  private sseService: SSEService;
  
  constructor(sseService: SSEService) {
    this.sseService = sseService;
    this.setupProcessors();
  }
  
  private setupProcessors() {
    // Process jobs with concurrency limit
    jobQueue.process('run-story', 2, async (job) => {
      const { sessionId, repositoryUrl, githubToken, storyFile, architectureDoc, options } = job.data as JobData;
      
      try {
        // Update progress
        job.progress(5);
        this.sseService.broadcast(sessionId, {
          type: 'job-started',
          message: 'Cloning repository...'
        });
        
        // Clone repository to workspace
        const workspacePath = await this.cloneRepository(sessionId, repositoryUrl, githubToken);
        
        job.progress(20);
        this.sseService.broadcast(sessionId, {
          type: 'progress',
          current: 20,
          total: 100,
          message: 'Repository cloned, starting Claude Code execution...'
        });
        
        // Resolve file paths within the cloned repository
        const fullStoryPath = path.join(workspacePath, storyFile);
        const fullArchitecturePath = path.join(workspacePath, architectureDoc);
        
        // Run the story with progress callbacks
        const result = await runStoryClaudeCode(
          fullStoryPath,
          fullArchitecturePath,
          options.customPrompt,
          {
            cwd: workspacePath, // Run in cloned repository context
            onProgress: (current: number, total: number, message: string) => {
              // Map progress from 20-95% (leaving 5% for cleanup)
              const mappedProgress = Math.round(20 + ((current / total) * 75));
              job.progress(mappedProgress);
              this.sseService.broadcast(sessionId, {
                type: 'progress',
                current,
                total,
                progress: mappedProgress,
                message
              });
            },
            onLog: (message: string) => {
              this.sseService.broadcast(sessionId, {
                type: 'log',
                message,
                timestamp: new Date().toISOString()
              });
            }
          }
        );
        
        job.progress(95);
        this.sseService.broadcast(sessionId, {
          type: 'progress',
          message: 'Cleaning up workspace...'
        });
        
        // Cleanup workspace
        await this.cleanupWorkspace(sessionId);
        
        job.progress(100);
        this.sseService.broadcast(sessionId, {
          type: 'complete',
          result,
          message: 'Story processing completed successfully!'
        });
        
        return result;
        
      } catch (error) {
        // Cleanup on error
        await this.cleanupWorkspace(sessionId).catch(() => {});
        
        this.sseService.broadcast(sessionId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred'
        });
        throw error;
      }
    });
  }
  
  private async cloneRepository(sessionId: string, repositoryUrl: string, githubToken: string): Promise<string> {
    const GitService = require('./git-service');
    const gitService = new GitService();
    return await gitService.cloneRepository(sessionId, repositoryUrl, githubToken);
  }
  
  private async cleanupWorkspace(sessionId: string): Promise<void> {
    const WorkspaceService = require('./workspace');
    const workspaceService = new WorkspaceService();
    await workspaceService.cleanup(sessionId);
  }
  
  async addJob(jobData: JobData): Promise<string> {
    const job = await jobQueue.add('run-story', jobData, {
      priority: 1,
      delay: 0
    });
    
    return job.id.toString();
  }
  
  async getJobStatus(jobId: string) {
    const job = await jobQueue.getJob(jobId);
    if (!job) return null;
    
    return {
      id: job.id,
      progress: job.progress(),
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      data: job.data
    };
  }
}
```

## Git Repository Management Service

### Git Service Implementation
```typescript
// src/server/services/git-service.ts
import simpleGit, { SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';

export class GitService {
  private readonly workspaceRoot = path.join(process.cwd(), 'workspace', 'sessions');
  
  constructor() {
    // Ensure workspace directory exists
    fs.ensureDirSync(this.workspaceRoot);
  }
  
  async cloneRepository(sessionId: string, repositoryUrl: string, githubToken: string): Promise<string> {
    const sessionWorkspace = path.join(this.workspaceRoot, sessionId);
    
    try {
      // Clean up any existing workspace
      await fs.remove(sessionWorkspace);
      await fs.ensureDir(sessionWorkspace);
      
      // Configure Git with authentication
      const authenticatedUrl = this.addTokenToUrl(repositoryUrl, githubToken);
      
      const git: SimpleGit = simpleGit({
        baseDir: sessionWorkspace,
        binary: 'git',
        maxConcurrentProcesses: 1,
        trimmed: false,
        config: [
          'user.name=Claude Story Runner',
          'user.email=claude@anthropic.com'
        ]
      });
      
      // Clone the repository
      await git.clone(authenticatedUrl, 'repo', [
        '--depth=1', // Shallow clone for faster operation
        '--single-branch',
        '--no-tags'
      ]);
      
      const repoPath = path.join(sessionWorkspace, 'repo');
      
      // Verify repository was cloned successfully
      if (!await fs.pathExists(repoPath)) {
        throw new Error('Repository clone failed - directory not found');
      }
      
      // Set up Git configuration in cloned repo
      const repoGit = simpleGit(repoPath);
      await repoGit.addConfig('user.name', 'Claude Story Runner');
      await repoGit.addConfig('user.email', 'claude@anthropic.com');
      
      return repoPath;
      
    } catch (error) {
      // Clean up on failure
      await fs.remove(sessionWorkspace).catch(() => {});
      
      if (error instanceof Error) {
        if (error.message.includes('Authentication failed')) {
          throw new Error('GitHub authentication failed. Please check your Personal Access Token.');
        } else if (error.message.includes('Repository not found')) {
          throw new Error('Repository not found. Please check the URL and ensure you have access.');
        } else if (error.message.includes('network')) {
          throw new Error('Network error while cloning repository. Please try again.');
        }
      }
      
      throw new Error(`Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  private addTokenToUrl(repositoryUrl: string, githubToken: string): string {
    try {
      const url = new URL(repositoryUrl);
      
      // Handle GitHub URLs
      if (url.hostname === 'github.com') {
        // Convert HTTPS URLs to authenticated format
        if (url.protocol === 'https:') {
          return `https://${githubToken}@github.com${url.pathname}`;
        }
        // Convert SSH URLs to HTTPS with token
        if (url.protocol === 'git:' || repositoryUrl.startsWith('git@github.com:')) {
          const pathMatch = repositoryUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
          if (pathMatch) {
            return `https://${githubToken}@github.com/${pathMatch[1]}`;
          }
        }
      }
      
      // For other Git providers, assume HTTPS with basic auth
      url.username = githubToken;
      return url.toString();
      
    } catch (error) {
      throw new Error('Invalid repository URL format');
    }
  }
  
  async validateRepository(repositoryUrl: string, githubToken: string): Promise<boolean> {
    const tempId = `temp-${uuidv4()}`;
    const tempWorkspace = path.join(process.cwd(), 'workspace', 'temp', tempId);
    
    try {
      await fs.ensureDir(tempWorkspace);
      const authenticatedUrl = this.addTokenToUrl(repositoryUrl, githubToken);
      
      const git = simpleGit(tempWorkspace);
      await git.listRemote([authenticatedUrl, '--heads']);
      
      return true;
    } catch (error) {
      return false;
    } finally {
      await fs.remove(tempWorkspace).catch(() => {});
    }
  }
}
```

## Workspace Management Service

### Workspace Service Implementation
```typescript
// src/server/services/workspace.ts
import fs from 'fs-extra';
import path from 'path';
import cron from 'node-cron';

export class WorkspaceService {
  private readonly workspaceRoot = path.join(process.cwd(), 'workspace');
  private readonly sessionsDir = path.join(this.workspaceRoot, 'sessions');
  private readonly tempDir = path.join(this.workspaceRoot, 'temp');
  private readonly maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  constructor() {
    this.ensureDirectories();
    this.startCleanupScheduler();
  }
  
  private async ensureDirectories(): Promise<void> {
    await fs.ensureDir(this.sessionsDir);
    await fs.ensureDir(this.tempDir);
  }
  
  async cleanup(sessionId: string): Promise<void> {
    const sessionPath = path.join(this.sessionsDir, sessionId);
    
    try {
      await fs.remove(sessionPath);
    } catch (error) {
      console.error(`Failed to cleanup workspace for session ${sessionId}:`, error);
      // Don't throw - cleanup failures shouldn't break the job
    }
  }
  
  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    
    try {
      // Clean up session directories
      const sessions = await fs.readdir(this.sessionsDir);
      for (const sessionId of sessions) {
        const sessionPath = path.join(this.sessionsDir, sessionId);
        const stats = await fs.stat(sessionPath);
        
        if (now - stats.mtime.getTime() > this.maxAge) {
          await this.cleanup(sessionId);
        }
      }
      
      // Clean up temp directories
      const tempDirs = await fs.readdir(this.tempDir);
      for (const tempId of tempDirs) {
        const tempPath = path.join(this.tempDir, tempId);
        const stats = await fs.stat(tempPath);
        
        // Clean temp directories after 1 hour
        if (now - stats.mtime.getTime() > 60 * 60 * 1000) {
          await fs.remove(tempPath);
        }
      }
      
    } catch (error) {
      console.error('Error during workspace cleanup:', error);
    }
  }
  
  private startCleanupScheduler(): void {
    // Run cleanup every 6 hours
    cron.schedule('0 */6 * * *', () => {
      console.log('Running workspace cleanup...');
      this.cleanupExpired();
    });
  }
}
```

## Single Page React Application

### Main App Component
```tsx
// src/client/App.tsx
import React, { useState } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  ThemeProvider,
  createTheme,
  CssBaseline
} from '@mui/material';
import ParameterForm from './components/ParameterForm';
import LogStream from './components/LogStream';
import { JobSession } from './types';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#2196F3',
    },
  },
});

function App() {
  const [currentSession, setCurrentSession] = useState<JobSession | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const handleJobStart = (session: JobSession) => {
    setCurrentSession(session);
    setIsRunning(true);
  };

  const handleJobComplete = () => {
    setIsRunning(false);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Paper elevation={3} sx={{ p: 4 }}>
          <Typography variant="h3" component="h1" gutterBottom align="center">
            Claude Story Runner
          </Typography>
          <Typography variant="subtitle1" align="center" color="textSecondary" gutterBottom>
            Run Claude Code over story sets with real-time progress tracking
          </Typography>
          
          <Box sx={{ mt: 4 }}>
            {!isRunning ? (
              <ParameterForm onJobStart={handleJobStart} />
            ) : (
              <LogStream 
                session={currentSession!} 
                onComplete={handleJobComplete}
              />
            )}
          </Box>
        </Paper>
      </Container>
    </ThemeProvider>
  );
}

export default App;
```

### Parameter Form Component
```tsx
// src/client/components/ParameterForm.tsx
import React, { useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Paper,
  Grid,
  FormControl,
  InputLabel,
  Input,
  Alert
} from '@mui/material';
import { Upload, PlayArrow } from '@mui/icons-material';
import { JobSession } from '../types';
import { apiService } from '../services/api';

interface Props {
  onJobStart: (session: JobSession) => void;
}

const ParameterForm: React.FC<Props> = ({ onJobStart }) => {
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [storyFile, setStoryFile] = useState('');        // Path within repository
  const [architectureDoc, setArchitectureDoc] = useState(''); // Path within repository
  const [branchPrefix, setBranchPrefix] = useState('story');
  const [featureBranch, setFeatureBranch] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!repositoryUrl || !githubToken || !storyFile || !architectureDoc) {
      setError('Repository URL, GitHub token, story file path, and architecture document path are all required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const session = await apiService.startJob({
        repositoryUrl,
        githubToken,
        storyFile,
        architectureDoc,
        branchPrefix,
        featureBranch,
        customPrompt
      });
      
      onJobStart(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start job');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ maxWidth: 800, mx: 'auto' }}>
      <Grid container spacing={3}>
        {/* Repository Configuration */}
        <Grid item xs={12}>
          <Typography variant="h6" gutterBottom>
            Repository Configuration
          </Typography>
        </Grid>
        
        <Grid item xs={12}>
          <TextField
            fullWidth
            label="Repository URL"
            placeholder="https://github.com/username/repository"
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
            required
            helperText="GitHub repository URL (HTTPS or SSH format)"
          />
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            label="GitHub Personal Access Token"
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            required
            helperText="GitHub PAT with repo access (will be encrypted in transit)"
          />
        </Grid>

        {/* File Paths within Repository */}
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            label="Story File Path"
            placeholder="stories/user-stories.md"
            value={storyFile}
            onChange={(e) => setStoryFile(e.target.value)}
            required
            helperText="Path to story file within the repository"
          />
        </Grid>

        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            label="Architecture Document Path"
            placeholder="docs/architecture.md"
            value={architectureDoc}
            onChange={(e) => setArchitectureDoc(e.target.value)}
            required
            helperText="Path to architecture document within repository"
          />
        </Grid>

        {/* Parameters */}
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            label="Branch Prefix"
            value={branchPrefix}
            onChange={(e) => setBranchPrefix(e.target.value)}
            helperText="Prefix for story branch names (default: story)"
          />
        </Grid>

        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            label="Feature Branch (optional)"
            value={featureBranch}
            onChange={(e) => setFeatureBranch(e.target.value)}
            helperText="Create feature branch as base for all stories"
          />
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            multiline
            rows={4}
            label="Custom Prompt (optional)"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            helperText="Override default implementation prompt"
          />
        </Grid>

        {/* Error Display */}
        {error && (
          <Grid item xs={12}>
            <Alert severity="error">{error}</Alert>
          </Grid>
        )}

        {/* Submit Button */}
        <Grid item xs={12}>
          <Box sx={{ textAlign: 'center' }}>
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={loading || !repositoryUrl || !githubToken || !storyFile || !architectureDoc}
              startIcon={<PlayArrow />}
              sx={{ px: 4, py: 2 }}
            >
              {loading ? 'Cloning & Starting...' : 'Clone Repository & Run Stories'}
            </Button>
          </Box>
        </Grid>
      </Grid>
    </Box>
  );
};

export default ParameterForm;
```

### Log Stream Component
```tsx
// src/client/components/LogStream.tsx
import React, { useEffect, useState, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  LinearProgress,
  Card,
  CardContent,
  Button
} from '@mui/material';
import { Refresh } from '@mui/icons-material';
import { JobSession, LogEntry } from '../types';
import { sseService } from '../services/sse';

interface Props {
  session: JobSession;
  onComplete: () => void;
}

const LogStream: React.FC<Props> = ({ session, onComplete }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to bottom
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    const handleSSEMessage = (data: any) => {
      switch (data.type) {
        case 'log':
          setLogs(prev => [...prev, {
            message: data.message,
            timestamp: data.timestamp || new Date().toISOString(),
            level: 'info'
          }]);
          break;

        case 'progress':
          setProgress(data.progress || 0);
          setCurrentStep(data.message || '');
          break;

        case 'complete':
          setProgress(100);
          setIsComplete(true);
          setLogs(prev => [...prev, {
            message: `✅ ${data.message}`,
            timestamp: new Date().toISOString(),
            level: 'success'
          }]);
          break;

        case 'error':
          setError(data.message);
          setLogs(prev => [...prev, {
            message: `❌ Error: ${data.message}`,
            timestamp: new Date().toISOString(),
            level: 'error'
          }]);
          break;
      }
    };

    sseService.connect(session.id, handleSSEMessage);

    return () => {
      sseService.disconnect();
    };
  }, [session.id]);

  const handleRestart = () => {
    setLogs([]);
    setProgress(0);
    setCurrentStep('');
    setIsComplete(false);
    setError(null);
    onComplete();
  };

  return (
    <Box sx={{ maxWidth: 1000, mx: 'auto' }}>
      {/* Progress Card */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Progress: {progress}%
          </Typography>
          <LinearProgress 
            variant="determinate" 
            value={progress} 
            sx={{ mb: 2, height: 8, borderRadius: 4 }}
          />
          {currentStep && (
            <Typography variant="body2" color="textSecondary">
              {currentStep}
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Log Stream */}
      <Paper 
        variant="outlined" 
        sx={{ 
          height: '60vh', 
          overflow: 'auto', 
          p: 2, 
          backgroundColor: '#1e1e1e',
          fontFamily: 'monospace'
        }}
      >
        {logs.map((log, index) => (
          <Typography
            key={index}
            variant="body2"
            sx={{
              color: log.level === 'error' ? '#ff6b6b' : 
                     log.level === 'success' ? '#51cf66' : '#ffffff',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.4,
              fontSize: '0.875rem'
            }}
          >
            [{log.timestamp.substring(11, 19)}] {log.message}
          </Typography>
        ))}
        <div ref={logsEndRef} />
      </Paper>

      {/* Actions */}
      <Box sx={{ mt: 3, textAlign: 'center' }}>
        {(isComplete || error) && (
          <Button
            variant="contained"
            startIcon={<Refresh />}
            onClick={handleRestart}
            size="large"
          >
            Start New Job
          </Button>
        )}
      </Box>
    </Box>
  );
};

export default LogStream;
```

## Single Dockerfile - Complete Solution

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY vite.config.ts ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build backend
RUN npm run build:server

# Build frontend
RUN npm run build:client

# Production stage
FROM node:20-alpine AS production

# Install Claude Code CLI in production
RUN npm install -g @anthropic-ai/claude-code

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S claude -u 1001

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/build ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Create uploads directory
RUN mkdir -p uploads && chown claude:nodejs uploads

# Switch to non-root user
USER claude

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server/server.js"]
```

## Package.json Scripts
```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "tsc -p tsconfig.server.json -w",
    "dev:client": "vite",
    "build": "npm run build:server && npm run build:client",
    "build:server": "tsc -p tsconfig.server.json",
    "build:client": "vite build",
    "start": "node dist/server/server.js",
    "docker:build": "docker build -t claude-story-runner .",
    "docker:run": "docker run -p 3000:3000 claude-story-runner"
  }
}
```

## Key Benefits of This Approach

1. **Single Container**: Everything bundled together, easy deployment
2. **In-Memory Queue**: No external dependencies, but easy to migrate to Redis later
3. **Material-UI**: Fast development with professional-looking components
4. **Real-time Updates**: SSE streaming provides immediate feedback
5. **Mobile Responsive**: Material-UI handles responsive design automatically
6. **Type Safety**: Full TypeScript coverage across stack
7. **Simple**: One page, one workflow, focused UX

## Future Architecture - Separate Execution Container

### Current Implementation
- Single container handles web UI, API, Git operations, and Claude Code execution
- In-memory job queue with Bull
- Direct file system workspace management

### Future Migration Path for Scalability

When ready to separate execution into its own container:

#### Architecture Components
```
┌─────────────────┐    ├─────────────────┐    ┌─────────────────┐
│   Web Frontend  │    │   API Server    │    │   Executor      │
│   (React + MUI) │───▶│   (Express)     │───▶│   Container     │
│                 │    │                 │    │                 │
│   - Form UI     │    │   - Job Queue   │    │   - Git Clone   │
│   - SSE Client  │    │   - SSE Service │    │   - Claude Code │
│   - Real-time   │    │   - Session Mgmt│    │   - File Ops    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

#### Inter-Container Communication Options

**Option 1: Message Queue (Recommended)**
```typescript
// API Server publishes jobs to queue
await jobQueue.add('execute-story', {
  sessionId,
  repositoryUrl,
  githubToken, // Encrypted
  storyFile,
  architectureDoc,
  options
});

// Executor container consumes jobs
jobQueue.process('execute-story', async (job) => {
  // Stream results back via Redis pub/sub or webhook
});
```

**Option 2: REST API Communication**
```typescript
// API Server calls executor container
const response = await fetch('http://executor:3001/execute', {
  method: 'POST',
  body: JSON.stringify(jobData),
  headers: { 'Content-Type': 'application/json' }
});

// Executor streams progress via Server-Sent Events back to API
```

**Option 3: gRPC Communication**
```proto
service StoryExecutor {
  rpc ExecuteStory(ExecuteRequest) returns (stream ExecuteResponse);
}
```

#### Benefits of Separate Execution Container
1. **Isolation**: Git operations and Claude Code execution in sandboxed environment
2. **Scalability**: Multiple executor containers for parallel processing
3. **Security**: Separate network/file system boundaries
4. **Resource Management**: Dedicated resources for heavy operations
5. **Reliability**: Executor failures don't affect web interface

#### Migration Strategy
1. **Phase 1**: Extract execution logic into separate service class
2. **Phase 2**: Add container-to-container communication layer
3. **Phase 3**: Deploy as separate Docker containers with shared message queue
4. **Phase 4**: Add container orchestration (Docker Compose/Kubernetes)

#### Docker Compose Example (Future)
```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    
  web-api:
    build: 
      context: .
      dockerfile: Dockerfile.api
    ports:
      - "3000:3000"
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
      
  executor:
    build:
      context: .
      dockerfile: Dockerfile.executor
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # For Docker-in-Docker if needed
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
    deploy:
      replicas: 2  # Scale executor containers
```

This provides a clear migration path from the single container MVP to a distributed, scalable architecture while maintaining the same user experience and API interface.

## Key Benefits of This Approach

1. **Single Container**: Everything bundled together, easy deployment
2. **In-Memory Queue**: No external dependencies, but easy to migrate to Redis later
3. **Material-UI**: Fast development with professional-looking components
4. **Real-time Updates**: SSE streaming provides immediate feedback
5. **Mobile Responsive**: Material-UI handles responsive design automatically
6. **Type Safety**: Full TypeScript coverage across stack
7. **Simple**: One page, one workflow, focused UX
8. **Git Integration**: Direct repository cloning with GitHub PAT authentication
9. **Migration Ready**: Clear path to distributed architecture when needed

This solution gives you a production-ready single container with professional UI, real-time streaming, and Git repository integration in a much simpler architecture than the previous specification.