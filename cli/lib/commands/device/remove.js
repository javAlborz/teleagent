import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import {
  loadConfigWithVoiceRuntimeIdentityPreflight,
  peekConfig,
  saveConfig,
  configExists,
} from '../../config.js';
import { writeDockerConfig } from '../../docker.js';

/**
 * Device remove command - Remove a device
 * @param {string} deviceName - Name of device to remove
 * @returns {Promise<void>}
 */
export async function deviceRemoveCommand(deviceName) {
  console.log(chalk.bold.cyan('\n🗑️  Remove Device\n'));

  if (!configExists()) {
    console.log(chalk.red('✗ Not configured'));
    console.log(chalk.gray('  Run "claude-phone setup" first\n'));
    process.exit(1);
  }

  // Resolve the full voice/media identity bundle before config migration or
  // any later save. API-only installations remain explicitly exempt.
  const configSnapshot = await peekConfig();
  const { config, voiceRuntimeIdentities } =
    await loadConfigWithVoiceRuntimeIdentityPreflight({ snapshot: configSnapshot });

  // Find device
  const deviceIndex = config.devices.findIndex(
    d => d.name.toLowerCase() === deviceName.toLowerCase()
  );

  if (deviceIndex === -1) {
    console.log(chalk.red(`✗ Device "${deviceName}" not found\n`));
    console.log(chalk.gray('Available devices:'));
    for (const device of config.devices) {
      console.log(chalk.gray(`  • ${device.name}`));
    }
    console.log();
    process.exit(1);
  }

  const device = config.devices[deviceIndex];

  // Prevent removing last device
  if (config.devices.length === 1) {
    console.log(chalk.red('✗ Cannot remove the last device'));
    console.log(chalk.gray('  At least one device must be configured\n'));
    process.exit(1);
  }

  // Confirm removal
  console.log(chalk.yellow('Device details:'));
  console.log(chalk.gray(`  Name: ${device.name}`));
  console.log(chalk.gray(`  Extension: ${device.extension}`));
  console.log(chalk.gray(`  Voice ID: ${device.voiceId}\n`));

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Are you sure you want to remove device "${device.name}"?`,
      default: false
    }
  ]);

  if (!confirmed) {
    console.log(chalk.gray('\nCancelled. No changes made.\n'));
    return;
  }

  // Remove device
  const spinner = ora('Removing device...').start();
  config.devices.splice(deviceIndex, 1);

  // Save config
  await saveConfig(config);

  // API-only installations have no voice deployment artifacts to regenerate.
  if (voiceRuntimeIdentities) {
    await writeDockerConfig(config, voiceRuntimeIdentities);
  }

  spinner.succeed(chalk.green('Device removed'));

  console.log(chalk.bold.green('\n✓ Device removed successfully!'));
  console.log(chalk.yellow('\n⚠ Restart services to apply changes:'));
  console.log(chalk.gray('  claude-phone stop'));
  console.log(chalk.gray('  claude-phone start\n'));
}
