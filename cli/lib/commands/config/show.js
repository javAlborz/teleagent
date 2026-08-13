import chalk from 'chalk';
import { loadConfig, configExists } from '../../config.js';

/**
 * Redact sensitive values for display
 * @param {string} value - Value to redact
 * @returns {string} Redacted value
 */
function redactValue(value) {
  if (!value || typeof value !== 'string') {
    return '[not set]';
  }

  // For API keys (typically long strings)
  if (value.length > 20) {
    const prefix = value.slice(0, 4);
    const suffix = value.slice(-4);
    return `${prefix}...${suffix}`;
  }

  // For passwords and shorter secrets
  return '••••••••';
}

/**
 * Config show command - Display configuration with redacted secrets
 * @returns {Promise<void>}
 */
export async function configShowCommand() {
  console.log(chalk.bold.cyan('\n⚙️  Teleagent Configuration\n'));

  // Check if configured
  if (!configExists()) {
    console.log(chalk.red('✗ Configuration not found'));
    console.log(chalk.gray('  Run "claude-phone setup" first\n'));
    return;
  }

  const config = await loadConfig();
  const ttsConfig = config.api?.tts || {};
  const sttConfig = config.api?.stt || {};
  const realtimeConfig = config.api?.realtime || {};

  console.log(chalk.bold('Speech Endpoints:'));
  console.log(chalk.gray(`  TTS Endpoint: ${ttsConfig.baseUrl || '[not set]'}`));
  console.log(chalk.gray(`  TTS Voice: ${ttsConfig.defaultVoice || '[not set]'}`));
  console.log(chalk.gray(`  TTS API Key: ${redactValue(ttsConfig.apiKey)}`));
  console.log(chalk.gray(`  STT Endpoint: ${sttConfig.baseUrl || '[not set]'}`));
  console.log(chalk.gray(`  STT API Key: ${redactValue(sttConfig.apiKey)}`));
  console.log(chalk.gray(`  OpenAI Realtime: ${realtimeConfig.enabled ? 'enabled' : 'disabled'}`));
  console.log(chalk.gray(`  Realtime Model: ${realtimeConfig.model || '[not set]'}`));
  console.log(chalk.gray(`  Realtime Voice: ${realtimeConfig.voice || '[not set]'}`));
  console.log(chalk.gray(`  OpenAI API Key: ${redactValue(realtimeConfig.apiKey)}`));

  // 3CX Configuration
  console.log(chalk.bold('\n3CX Configuration:'));
  console.log(chalk.gray(`  SIP Domain: ${config.sip.domain}`));
  console.log(chalk.gray(`  SIP Registrar: ${config.sip.registrar}`));

  // Server Configuration
  console.log(chalk.bold('\nServer:'));
  console.log(chalk.gray(`  External IP: ${config.server.externalIp}`));
  console.log(chalk.gray(`  Voice App Port: ${config.server.httpPort}`));
  console.log(chalk.gray(`  Agent API Port: ${config.server.claudeApiPort}`));
  console.log(chalk.gray(`  Agent Providers: ${(config.agents?.providers || ['claude']).join(', ')}`));

  // Devices
  console.log(chalk.bold('\nDevices:'));
  if (config.devices.length === 0) {
    console.log(chalk.gray('  (none configured)'));
  } else {
    for (const device of config.devices) {
      console.log(chalk.gray(`  • ${device.name} (extension ${device.extension})`));
      console.log(chalk.gray(`    Auth ID: ${device.authId}`));
      console.log(chalk.gray(`    Password: ${redactValue(device.password)}`));
      console.log(chalk.gray(`    Voice ID: ${device.voiceId}`));
      if (device.prompt) {
        const shortPrompt = device.prompt.length > 50
          ? device.prompt.slice(0, 50) + '...'
          : device.prompt;
        console.log(chalk.gray(`    Prompt: ${shortPrompt}`));
      }
    }
  }

  console.log(chalk.gray(`\n💡 To view the raw config file, run: claude-phone config path\n`));
}
