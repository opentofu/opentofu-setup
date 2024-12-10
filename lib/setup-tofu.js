/**
 * Copyright (c) HashiCorp, Inc.
 * Copyright (c) OpenTofu
 * SPDX-License-Identifier: MPL-2.0
 */

// Node.js core
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

// External
const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const releases = require('./releases');

// arch in [arm, x32, x64...] (https://nodejs.org/api/os.html#os_os_arch)
// return value in [amd64, 386, arm]
function mapArch (arch) {
  const mappings = {
    x32: '386',
    x64: 'amd64'
  };
  return mappings[arch] || arch;
}

// os in [darwin, linux, win32...] (https://nodejs.org/api/os.html#os_os_platform)
// return value in [darwin, linux, windows]
function mapOS (os) {
  if (os === 'win32') {
    return 'windows';
  }
  return os;
}

async function downloadAndExtractCLI (url) {
  core.debug(`Downloading OpenTofu CLI from ${url}`);
  const pathToCLIZip = await tc.downloadTool(url);

  if (!pathToCLIZip) {
    throw new Error(`Unable to download OpenTofu from ${url}`);
  }

  let pathToCLI;

  core.debug('Extracting OpenTofu CLI zip file');
  if (os.platform().startsWith('win')) {
    core.debug(`OpenTofu CLI Download Path is ${pathToCLIZip}`);
    const fixedPathToCLIZip = `${pathToCLIZip}.zip`;
    await io.mv(pathToCLIZip, fixedPathToCLIZip);
    core.debug(`Moved download to ${fixedPathToCLIZip}`);
    pathToCLI = await tc.extractZip(fixedPathToCLIZip);
  } else {
    pathToCLI = await tc.extractZip(pathToCLIZip);
  }

  core.debug(`OpenTofu CLI path is ${pathToCLI}.`);

  if (!pathToCLI) {
    throw new Error('Unable to unzip OpenTofu');
  }

  return pathToCLI;
}

async function installWrapper (pathToCLI) {
  let source, target;

  // If we're on Windows, then the executable ends with .exe
  const exeSuffix = os.platform().startsWith('win') ? '.exe' : '';

  // Rename tofu(.exe) to tofu-bin(.exe)
  try {
    source = [pathToCLI, `tofu${exeSuffix}`].join(path.sep);
    target = [pathToCLI, `tofu-bin${exeSuffix}`].join(path.sep);
    core.debug(`Moving ${source} to ${target}.`);
    await io.mv(source, target);
  } catch (e) {
    core.error(`Unable to move ${source} to ${target}.`);
    throw e;
  }

  // Install our wrapper as tofu
  try {
    source = path.resolve([__dirname, '..', 'wrapper', 'dist', 'index.js'].join(path.sep));
    target = [pathToCLI, 'tofu'].join(path.sep);
    core.debug(`Copying ${source} to ${target}.`);
    await io.cp(source, target);
  } catch (e) {
    core.error(`Unable to copy ${source} to ${target}.`);
    throw e;
  }

  // Export a new environment variable, so our wrapper can locate the binary
  core.exportVariable('TOFU_CLI_PATH', pathToCLI);
}

// Add credentials to CLI Configuration File
// https://www.tofu.io/docs/commands/cli-config.html
async function addCredentials (credentialsHostname, credentialsToken, osPlat) {
  // format HCL block
  // eslint-disable
  const creds = `
credentials "${credentialsHostname}" {
  token = "${credentialsToken}"
}`.trim();
    // eslint-enable

  // default to OS-specific path
  let credsFile = osPlat === 'win32'
    ? `${process.env.APPDATA}/tofu.rc`
    : `${process.env.HOME}/.tofurc`;

  // override with TF_CLI_CONFIG_FILE environment variable
  credsFile = process.env.TF_CLI_CONFIG_FILE ? process.env.TF_CLI_CONFIG_FILE : credsFile;

  // get containing folder
  const credsFolder = path.dirname(credsFile);

  core.debug(`Creating ${credsFolder}`);
  await io.mkdirP(credsFolder);

  core.debug(`Adding credentials to ${credsFile}`);
  await fs.writeFile(credsFile, creds);
}

async function run () {
  try {
    // Gather GitHub Actions inputs
    const version = core.getInput('tofu_version');
    const credentialsHostname = core.getInput('cli_config_credentials_hostname');
    const credentialsToken = core.getInput('cli_config_credentials_token');
    const wrapper = core.getInput('tofu_wrapper') === 'true';
    let githubToken = core.getInput('github_token');
    if (githubToken === '' && !(process.env.FORGEJO_ACTIONS || process.env.GITEA_ACTIONS)) {
      // Only default to the environment variable when running in GitHub Actions. Don't do this for other CI systems
      // that may set the GITHUB_TOKEN environment variable.
      githubToken = process.env.GITHUB_TOKEN;
    }

    // Gather OS details
    const osPlatform = os.platform();
    const osArch = os.arch();

    core.debug(`Finding releases for OpenTofu version ${version}`);
    const release = await releases.getRelease(version, githubToken);
    const platform = mapOS(osPlatform);
    const arch = mapArch(osArch);
    const build = release.getBuild(platform, arch);
    if (!build) {
      throw new Error(`OpenTofu version ${version} not available for ${platform} and ${arch}`);
    }

    // Download requested version
    const pathToCLI = await downloadAndExtractCLI(build.url);

    const stepDebugLogging = core.getInput('step_debug_logging');
    core.exportVariable('ACTIONS_STEP_DEBUG', stepDebugLogging);

    // Install our wrapper
    if (wrapper) {
      await installWrapper(pathToCLI);
    }

    // Add to path
    core.addPath(pathToCLI);

    // Add credentials to file if they are provided
    if (credentialsHostname && credentialsToken) {
      await addCredentials(credentialsHostname, credentialsToken, osPlatform);
    }
    return release;
  } catch (error) {
    core.error(error);
    throw error;
  }
}

module.exports = run;
