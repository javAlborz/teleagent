import os from 'os';
import { spawn } from 'child_process';

export const AGENT_PROVIDERS = ['claude', 'codex'];

const PROFILE_CHOICES = {
  claude: [
    { name: 'Claude Haiku - fast, read-oriented', value: 'phone-haiku' },
    { name: 'Claude Sonnet - balanced', value: 'phone-sonnet' },
    { name: 'Claude Opus - deep work', value: 'phone-opus' }
  ],
  codex: [
    { name: 'Codex GPT-5.6 Luna - low reasoning, read-only', value: 'phone-codex-luna' },
    { name: 'Codex GPT-5.6 Terra - medium reasoning, workspace write', value: 'phone-codex-terra' },
    { name: 'Codex GPT-5.6 Sol - high reasoning, full access', value: 'phone-codex-sol' }
  ]
};

function uniqueProviders(providers, fallback = ['claude']) {
  const normalized = Array.isArray(providers)
    ? providers.map(provider => String(provider).trim().toLowerCase())
    : [];
  const selected = AGENT_PROVIDERS.filter(provider => normalized.includes(provider));
  return selected.length > 0 ? selected : [...fallback];
}

export function createDefaultAgentConfig({
  providers = ['claude', 'codex'],
  homeDirectory = os.homedir()
} = {}) {
  return {
    providers: uniqueProviders(providers, ['claude', 'codex']),
    claude: {
      command: 'claude',
      workingDirectory: homeDirectory
    },
    codex: {
      command: 'codex',
      workingDirectory: homeDirectory,
      approvalPolicy: 'never',
      luna: {
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        sandbox: 'read-only',
        workingDirectory: homeDirectory
      },
      terra: {
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        sandbox: 'workspace-write',
        workingDirectory: homeDirectory
      },
      sol: {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        sandbox: 'danger-full-access',
        workingDirectory: homeDirectory
      }
    }
  };
}

export function normalizeAgentConfig(agentConfig, {
  defaultProviders = ['claude'],
  homeDirectory = os.homedir()
} = {}) {
  const defaults = createDefaultAgentConfig({ providers: defaultProviders, homeDirectory });
  const current = agentConfig || {};
  const codex = current.codex || {};

  return {
    ...defaults,
    ...current,
    providers: uniqueProviders(current.providers, defaultProviders),
    claude: {
      ...defaults.claude,
      ...(current.claude || {})
    },
    codex: {
      ...defaults.codex,
      ...codex,
      luna: {
        ...defaults.codex.luna,
        ...(codex.luna || {})
      },
      terra: {
        ...defaults.codex.terra,
        ...(codex.terra || {})
      },
      sol: {
        ...defaults.codex.sol,
        ...(codex.sol || {})
      }
    }
  };
}

export function getConfiguredAgentProviders(config) {
  return normalizeAgentConfig(config?.agents).providers;
}

export function getAgentProfileChoices(config) {
  return getConfiguredAgentProviders(config)
    .flatMap(provider => PROFILE_CHOICES[provider] || []);
}

export function buildAgentServerEnvironment(config, baseEnvironment = process.env) {
  const agents = normalizeAgentConfig(config?.agents);
  const codex = agents.codex;

  return {
    ...baseEnvironment,
    AGENT_PROVIDERS: agents.providers.join(','),
    CLAUDE_COMMAND: agents.claude.command,
    CLAUDE_WORKING_DIR: agents.claude.workingDirectory,
    CODEX_COMMAND: codex.command,
    CODEX_WORKING_DIR: codex.workingDirectory,
    PHONE_CODEX_APPROVAL_POLICY: codex.approvalPolicy,
    PHONE_CODEX_LUNA_MODEL: codex.luna.model,
    PHONE_CODEX_LUNA_REASONING_EFFORT: codex.luna.reasoningEffort,
    PHONE_CODEX_LUNA_SANDBOX: codex.luna.sandbox,
    PHONE_CODEX_LUNA_WORKING_DIR: codex.luna.workingDirectory,
    PHONE_CODEX_TERRA_MODEL: codex.terra.model,
    PHONE_CODEX_TERRA_REASONING_EFFORT: codex.terra.reasoningEffort,
    PHONE_CODEX_TERRA_SANDBOX: codex.terra.sandbox,
    PHONE_CODEX_TERRA_WORKING_DIR: codex.terra.workingDirectory,
    PHONE_CODEX_SOL_MODEL: codex.sol.model,
    PHONE_CODEX_SOL_REASONING_EFFORT: codex.sol.reasoningEffort,
    PHONE_CODEX_SOL_SANDBOX: codex.sol.sandbox,
    PHONE_CODEX_SOL_WORKING_DIR: codex.sol.workingDirectory,
    PHONE_CODEX_DEPLOY_MODEL: codex.sol.model,
    PHONE_CODEX_DEPLOY_REASONING_EFFORT: codex.sol.reasoningEffort,
    PHONE_CODEX_DEPLOY_SANDBOX: codex.sol.sandbox,
    PHONE_CODEX_DEPLOY_WORKING_DIR: codex.sol.workingDirectory
  };
}

export function runCliCommand(command, args, spawnImpl = spawn) {
  return new Promise(resolve => {
    const child = spawnImpl(command, args, { stdio: 'pipe' });
    let output = '';
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on('data', data => {
      output += data.toString();
    });
    child.stderr?.on('data', data => {
      output += data.toString();
    });
    child.on('error', error => {
      finish({ ok: false, output: output.trim(), error: error.message });
    });
    child.on('close', code => {
      finish({
        ok: code === 0,
        code,
        output: output.trim(),
        error: code === 0 ? null : output.trim() || `Exited with code ${code}`
      });
    });
  });
}

export async function checkAgentProvider(provider, config, { spawnImpl = spawn } = {}) {
  const agents = normalizeAgentConfig(config?.agents);
  const providerConfig = agents[provider];

  if (!providerConfig || !AGENT_PROVIDERS.includes(provider)) {
    return { provider, installed: false, authenticated: false, error: `Unknown provider: ${provider}` };
  }

  const versionResult = await runCliCommand(providerConfig.command, ['--version'], spawnImpl);
  if (!versionResult.ok) {
    return {
      provider,
      installed: false,
      authenticated: false,
      error: `${providerConfig.command} is not available in PATH`
    };
  }

  const versionMatch = versionResult.output.match(/(\d+\.\d+(?:\.\d+)?)/);
  const result = {
    provider,
    installed: true,
    authenticated: true,
    version: versionMatch ? versionMatch[1] : versionResult.output || 'unknown'
  };

  if (provider === 'codex' || provider === 'claude') {
    const authArgs = provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
    const authResult = await runCliCommand(providerConfig.command, authArgs, spawnImpl);
    result.authenticated = authResult.ok;
    if (!authResult.ok) {
      result.error = provider === 'codex'
        ? 'Codex is not authenticated; run "codex login" (or "codex login --device-auth" on a headless host)'
        : 'Claude Code is not authenticated; run "claude auth login"';
    }
  }

  return result;
}

export async function checkConfiguredAgentProviders(config, options = {}) {
  const providers = getConfiguredAgentProviders(config);
  return Promise.all(providers.map(provider => checkAgentProvider(provider, config, options)));
}
