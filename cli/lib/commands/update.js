import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync } from 'child_process';
import { loadConfig, saveConfig, configExists } from '../config.js';

const CANONICAL_GITHUB_REPO = 'javAlborz/teleagent';

function buildGitHubRepoUrl(repoSlug = CANONICAL_GITHUB_REPO) {
  return `https://github.com/${repoSlug}`;
}

function buildRawInstallUrl(repoSlug = CANONICAL_GITHUB_REPO) {
  return `https://raw.githubusercontent.com/${repoSlug}/main/install.sh`;
}

function parseGitHubRepoSlug(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value) return null;

  const scpMatch = value.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (scpMatch) return scpMatch[1];

  try {
    const parsed = new globalThis.URL(value);
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const slug = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
    return slug || null;
  } catch {
    return null;
  }
}

/**
 * Check for git repository
 * @param {string} projectRoot - Root directory of claude-phone
 * @returns {boolean} True if git repo
 */
function isGitRepo(projectRoot) {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git branch
 * @param {string} projectRoot - Root directory of claude-phone
 * @returns {string} Branch name
 */
function getCurrentBranch(projectRoot) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getOriginRepoSlug(projectRoot) {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim();
    return parseGitHubRepoSlug(remoteUrl) || CANONICAL_GITHUB_REPO;
  } catch {
    return CANONICAL_GITHUB_REPO;
  }
}

/**
 * Get project root directory (where package.json is)
 * @returns {string} Project root path
 */
function getProjectRoot() {
  // CLI is in cli/lib/commands/, project root is three levels up
  const currentFile = fileURLToPath(import.meta.url);
  const commandsDir = path.dirname(currentFile);
  const libDir = path.dirname(commandsDir);
  const cliDir = path.dirname(libDir);
  const projectRoot = path.dirname(cliDir);
  return fs.realpathSync(projectRoot);
}

/**
 * Fetch latest release info from GitHub
 * @returns {Promise<object>} Release info
 */
async function fetchLatestRelease(repoSlug = CANONICAL_GITHUB_REPO) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoSlug}/releases/latest`,
      {
        headers: {
          'User-Agent': 'claude-phone-cli',
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(`Failed to fetch latest release: ${error.message}`);
  }
}

/**
 * Update via git pull
 * @param {string} projectRoot - Root directory
 * @returns {Promise<void>}
 */
async function updateViaGit(projectRoot) {
  console.log(chalk.bold('\nUpdating from git...\n'));

  try {
    // Check current branch
    const branch = getCurrentBranch(projectRoot);
    console.log(chalk.gray(`Current branch: ${branch}`));

    // Fetch latest
    console.log(chalk.gray('Fetching latest changes...'));
    execSync('git fetch origin', {
      cwd: projectRoot,
      stdio: 'inherit'
    });

    // Check for uncommitted changes
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    if (status.trim()) {
      console.log(chalk.yellow('\n⚠️  You have uncommitted changes:'));
      console.log(chalk.gray(status));
      const { proceed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Continue with update? (changes will be stashed)',
          default: false
        }
      ]);

      if (!proceed) {
        console.log(chalk.gray('\n✗ Update cancelled\n'));
        return;
      }

      // Stash changes
      execSync('git stash', { cwd: projectRoot, stdio: 'inherit' });
      console.log(chalk.green('✓ Changes stashed'));
    }

    // Pull latest
    console.log(chalk.gray('\nPulling latest changes...'));
    execSync('git pull origin main', {
      cwd: projectRoot,
      stdio: 'inherit'
    });

    console.log(chalk.green('\n✓ Update complete\n'));
    console.log(chalk.gray('Run "claude-phone status" to verify services\n'));
  } catch (error) {
    throw new Error(`Git update failed: ${error.message}`);
  }
}

/**
 * Show manual update instructions
 * @param {object} release - Latest release info
 * @returns {void}
 */
function showManualInstructions(release, repoSlug = CANONICAL_GITHUB_REPO) {
  const repoUrl = buildGitHubRepoUrl(repoSlug);
  const installUrl = buildRawInstallUrl(repoSlug);

  console.log(chalk.bold('\n📥 Manual Update Instructions\n'));
  if (release) {
    console.log(chalk.gray('Latest version:'), chalk.bold(release.tag_name));
    console.log(chalk.gray('Released:'), release.published_at.split('T')[0]);
  } else {
    console.log(chalk.gray('Latest release:'), chalk.bold('No tagged release found'));
    console.log(chalk.gray('Using the current main branch from:'), chalk.bold(repoUrl));
  }
  console.log();

  console.log(chalk.bold('To update manually:\n'));
  console.log(chalk.gray('1. Stop all services:'));
  console.log(chalk.bold('   claude-phone stop\n'));

  console.log(chalk.gray('2. Backup your configuration:'));
  console.log(chalk.bold('   cp ~/.claude-phone/config.json ~/config.json.backup\n'));

  console.log(chalk.gray('3. Run the installer:'));
  console.log(chalk.bold(`   curl -sSL ${installUrl} | bash\n`));

  console.log(chalk.gray('4. Start services:'));
  console.log(chalk.bold('   claude-phone start\n'));

  console.log(chalk.yellow('⚠️  Your configuration will be preserved automatically\n'));
}

/**
 * Update command - Update Claude Phone to latest version
 * @returns {Promise<void>}
 */
export async function updateCommand() {
  console.log(chalk.bold.cyan('\n🔄 Update Claude Phone\n'));

  const projectRoot = getProjectRoot();
  const repoSlug = isGitRepo(projectRoot) ? getOriginRepoSlug(projectRoot) : CANONICAL_GITHUB_REPO;

  // Backup config before update
  if (configExists()) {
    console.log(chalk.gray('Backing up configuration...'));
    const config = await loadConfig();
    const backupPath = `${process.env.HOME}/.claude-phone/config.json.pre-update`;
    await saveConfig(config); // This creates a backup automatically
    console.log(chalk.green(`✓ Config backed up to: ${backupPath}`));
  }

  // Check if git repo
  if (isGitRepo(projectRoot)) {
    console.log(chalk.gray('Detected git installation\n'));
    await updateViaGit(projectRoot);
  } else {
    // Non-git installation - show manual instructions
    console.log(chalk.gray('Checking for latest release...\n'));

    try {
      const release = await fetchLatestRelease(repoSlug);
      showManualInstructions(release, repoSlug);
    } catch (error) {
      console.log(chalk.red(`\n✗ ${error.message}\n`));
      console.log(chalk.gray(`Visit ${buildGitHubRepoUrl(repoSlug)} for manual update\n`));
    }
  }
}
