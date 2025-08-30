import { spawn, SpawnOptions } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import logger from '../lib/logger.js';

export interface GitServiceOptions {
  workspaceRoot?: string;
  timeout?: number;
}

export interface CloneOptions {
  depth?: number;
  singleBranch?: boolean;
  noTags?: boolean;
}

export interface StreamCallback {
  onLog?: (message: string, level: 'info' | 'error' | 'warn') => void;
  onProgress?: (current: number, total: number, message: string) => void;
}

export class GitService {
  private readonly workspaceRoot: string;
  private readonly timeout: number;

  constructor(options: GitServiceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot || path.join(process.cwd(), 'workspace', 'sessions');
    this.timeout = options.timeout || 300000; // 5 minutes default timeout
    
    // Ensure workspace directory exists
    fs.ensureDirSync(this.workspaceRoot);
  }

  /**
   * Clone a repository using authenticated URL for the given session
   */
  async cloneRepository(
    sessionId: string, 
    repositoryUrl: string, 
    githubToken: string,
    callbacks?: StreamCallback
  ): Promise<string> {
    const sessionWorkspace = path.join(this.workspaceRoot, sessionId);
    
    try {
      callbacks?.onLog?.(`Starting repository clone for session ${sessionId}`, 'info');
      callbacks?.onProgress?.(0, 100, 'Preparing workspace...');
      
      // Clean up any existing workspace
      await fs.remove(sessionWorkspace);
      await fs.ensureDir(sessionWorkspace);
      
      callbacks?.onProgress?.(10, 100, 'Authenticating repository URL...');
      
      // Configure Git with authentication
      const authenticatedUrl = this.addTokenToUrl(repositoryUrl, githubToken);
      const repoPath = path.join(sessionWorkspace, 'repo');
      
      callbacks?.onProgress?.(20, 100, 'Cloning repository...');
      
      // Clone the repository with streaming output
      await this.executeGitCommand([
        'clone',
        authenticatedUrl,
        'repo',
        '--depth=1',
        '--single-branch',
        '--no-tags'
      ], sessionWorkspace, callbacks);
      
      callbacks?.onProgress?.(80, 100, 'Verifying clone...');
      
      // Verify repository was cloned successfully
      if (!await fs.pathExists(repoPath)) {
        throw new Error('Repository clone failed - directory not found');
      }
      
      callbacks?.onProgress?.(90, 100, 'Configuring Git...');
      
      // Set up Git configuration in cloned repo
      await this.executeGitCommand([
        'config', 'user.name', 'Claude Story Runner'
      ], repoPath, callbacks);
      
      await this.executeGitCommand([
        'config', 'user.email', 'claude@anthropic.com'
      ], repoPath, callbacks);
      
      callbacks?.onProgress?.(100, 100, 'Repository clone completed');
      callbacks?.onLog?.(`Repository cloned successfully to ${repoPath}`, 'info');
      
      return repoPath;
      
    } catch (error) {
      // Clean up on failure
      await fs.remove(sessionWorkspace).catch(() => {});
      
      if (error instanceof Error) {
        let errorMessage = error.message;
        
        if (error.message.includes('Authentication failed')) {
          errorMessage = 'GitHub authentication failed. Please check your Personal Access Token.';
        } else if (error.message.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (error.message.includes('network') || error.message.includes('timeout')) {
          errorMessage = 'Network error while cloning repository. Please try again.';
        }
        
        callbacks?.onLog?.(`Clone failed: ${errorMessage}`, 'error');
        throw new Error(errorMessage);
      }
      
      callbacks?.onLog?.(`Clone failed: Unknown error`, 'error');
      throw new Error(`Failed to clone repository: ${error}`);
    }
  }

  /**
   * Execute a Git command with streaming output support
   */
  private executeGitCommand(
    args: string[], 
    cwd: string, 
    callbacks?: StreamCallback
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: SpawnOptions = {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      };

      const gitProcess = spawn('git', args, options);
      
      // Set timeout
      const timeoutHandle = setTimeout(() => {
        gitProcess.kill('SIGTERM');
        reject(new Error(`Git command timed out after ${this.timeout}ms`));
      }, this.timeout);

      let stdout = '';
      let stderr = '';

      gitProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        callbacks?.onLog?.(output.trim(), 'info');
      });

      gitProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        
        // Git outputs progress to stderr, so check if it's actually an error
        if (output.includes('error:') || output.includes('fatal:')) {
          callbacks?.onLog?.(output.trim(), 'error');
        } else {
          callbacks?.onLog?.(output.trim(), 'info');
        }
      });

      gitProcess.on('close', (code) => {
        clearTimeout(timeoutHandle);
        
        if (code === 0) {
          resolve();
        } else {
          const errorMsg = `Git command failed with code ${code}: ${stderr}`;
          logger.error({ args, code, stderr, stdout }, 'Git command failed');
          reject(new Error(errorMsg));
        }
      });

      gitProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        logger.error({ error, args }, 'Git process error');
        reject(new Error(`Git process error: ${error.message}`));
      });
    });
  }

  /**
   * Add GitHub token to repository URL for authentication
   */
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

  /**
   * Validate repository access without cloning
   */
  async validateRepository(repositoryUrl: string, githubToken: string): Promise<boolean> {
    const tempId = `temp-${uuidv4()}`;
    const tempWorkspace = path.join(process.cwd(), 'workspace', 'temp', tempId);
    
    try {
      await fs.ensureDir(tempWorkspace);
      const authenticatedUrl = this.addTokenToUrl(repositoryUrl, githubToken);
      
      await this.executeGitCommand(['ls-remote', '--heads', authenticatedUrl], tempWorkspace);
      
      return true;
    } catch (error) {
      logger.warn({ repositoryUrl, error: error instanceof Error ? error.message : error }, 'Repository validation failed');
      return false;
    } finally {
      await fs.remove(tempWorkspace).catch(() => {});
    }
  }

  /**
   * Clean up session workspace
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const sessionPath = path.join(this.workspaceRoot, sessionId);
    
    try {
      await fs.remove(sessionPath);
      logger.info({ sessionId }, 'Session workspace cleaned up');
    } catch (error) {
      logger.error({ 
        sessionId, 
        error: error instanceof Error ? error.message : error 
      }, 'Failed to cleanup session workspace');
      // Don't throw - cleanup failures shouldn't break the job
    }
  }

  /**
   * Get the path to the cloned repository for a session
   */
  getRepositoryPath(sessionId: string): string {
    return path.join(this.workspaceRoot, sessionId, 'repo');
  }
}